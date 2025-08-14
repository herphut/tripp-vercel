// api/chat.js
export const config = { runtime: 'edge' };

const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function allowOrigin(origin) {
  return !ALLOWED.length || ALLOWED.includes(origin);
}

// --- backoff for 429 before streaming ---
async function preflightFetch(url, opts, tries = 3) {
  let attempt = 0;
  let lastText = '';
  while (attempt < tries) {
    const res = await fetch(url, opts);
    if (res.status !== 429) return res;
    try { lastText = await res.text(); } catch {}
    await new Promise(r => setTimeout(r, 800 * Math.pow(2, attempt))); // 800ms, 1600ms, 3200ms
    attempt++;
  }
  return new Response(lastText || 'Rate limited (429). Please retry shortly.', { status: 429 });
}

// --- Tripp persona ---
const TRIPP_SYSTEM = `
You are Tripp, HerpHut’s friendly reptile expert and site guide.
Style: upbeat, concise, punny-but-helpful (“let’s scale this down”), kid-safe.
Priorities:
1) Accuracy first; note when info varies by species/locale.
2) Safety: warn about common mistakes (heat rocks, loose substrate risks/impaction, cohab issues, UVB/humidity needs).
3) Practicality: give ranges and simple steps; mention affordable alternatives.
4) Ethics & legality: flag local laws at a high level; do not give legal advice.
5) Scope: reptiles + amphibians + common inverts + select small exotics (ferrets, chinchillas, hedgehogs). If out of scope, say so.
Answer format:
- Start with a one-sentence TL;DR when helpful.
- Then short bullets or mini-steps.
- Offer 1–2 Pro Tips.
Keep answers tight unless asked to go deeper.
`.trim();

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';

  if (!allowOrigin(origin)) {
    return new Response('Forbidden', { status: 403 });
  }

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

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  const messages = Array.isArray(body && body.messages) ? body.messages : null;
  if (!messages) {
    return new Response('Bad Request', { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response('Missing API key', { status: 500 });
  }

  const modelMessages = [{ role: 'system', content: TRIPP_SYSTEM }].concat(messages);

  const payload = {
    model: 'gpt-4o-mini',
    messages: modelMessages,
    stream: true,
    max_tokens: 350,
    temperature: 0.4
  };

  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
  const url = base + '/v1/chat/completions';
