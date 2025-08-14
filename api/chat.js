// api/chat.js
export const config = { runtime: 'edge' };

const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const allowOrigin = (origin) => !ALLOWED.length || ALLOWED.includes(origin);

// --- simple backoff for 429 before we start streaming ---
async function preflightFetch(url, opts, tries = 3) {
  let attempt = 0, lastText = '';
  while (attempt < tries) {
    const res = await fetch(url, opts);
    if (res.status !== 429) return res;
    lastText = await res.text().catch(() => '');
    await new Promise(r => setTimeout(r, 800 * Math.pow(2, attempt))); // 800ms, 1600ms, 3200ms
    attempt++;
  }
  return new Response(lastText || 'Rate limited (429). Please retry shortly.', { status: 429 });
}

// --- Tripp's persona/system prompt ---
const TRIPP_SYSTEM = `
You are **Tripp**, HerpHut’s friendly reptile expert and site guide.
Style: upbeat, concise, punny-but-helpful (“let’s scale this down”), kid-safe.
Priorities:
1) Accuracy first; note when info varies by species/locale.
2) Safety: warn about common mistakes (heat rocks, loose substrate risks, impaction, cohab issues, UVB needs, humidity).
3) Practicality: give ranges and simple steps; mention affordable alternatives.
4) Ethics & legality: flag local laws/husbandry rules at a high level; do not give legal advice.
5) Scope: reptiles + amphibians + common inverts + select small exotics (ferrets, chinchillas, hedgehogs). If out-of-scope, say so and redirect.
Answer format:
- Start with a one-sentence TL;DR when appropriate.
- Follow with short bullets or mini-steps.
- Offer 1–2 “Pro tips”.
Keep answers tight unless the user asks to go deeper.
`;

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';
  if (!allowOrigin(origin)) return new Response('Forbidden', { status: 403 });

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  let body;
  try { body = await req.json(); } catch { return new Response('Bad Request', { status: 400 }); }
  const { messages } = body || {};
  if (!Array.isArray(messages)) return new Response('Bad Request', { status: 400 });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return new Response('Missing API key', { status: 500 });

  // Prepend Tripp's system prompt
  const modelMessages = [
    { role: 'system', content: TRIPP_SYSTEM.trim() },
    ...messages
  ];

  const payload = {
    model: 'gpt-4o-mini',
    messages:
