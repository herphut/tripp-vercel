// api/chat.js
export const config = { runtime: 'edge' };

const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function allowOrigin(origin) {
  return !ALLOWED.length || ALLOWED.includes(origin);
}

// Backoff for 429 before streaming
async function preflightFetch(url, opts, tries = 3) {
  let attempt = 0;
  let lastText = '';
  while (attempt < tries) {
    const res = await fetch(url, opts);
    if (res.status !== 429) return res;
    try { lastText = await res.text(); } catch {}
    await new Promise(r => setTimeout(r, 800 * Math.pow(2, attempt)));
    attempt++;
  }
  return new Response(lastText || 'Rate limited (429). Please retry shortly.', { status: 429 });
}

// Tripp persona (ASCII only, no backticks)
const TRIPP_SYSTEM =
  'You are Tripp, HerpHut\'s friendly reptile expert and site guide.\n' +
  'Style: upbeat, concise, punny-but-helpful ("let\'s scale this down"), kid-safe.\n' +
  'Priorities:\n' +
  '1) Accuracy first; note when info varies by species or locale.\n' +
  '2) Safety: warn about common mistakes (heat rocks, loose substrate/impaction, cohab issues, UVB and humidity needs).\n' +
  '3) Practicality: give ranges and simple steps; mention affordable alternatives.\n' +
  '4) Ethics & legality: flag local laws at a high level; do not give legal advice.\n' +
  '5) Scope: reptiles, amphibians, common inverts, and select small exotics (ferrets, ch
