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

// Tripp persona (safe ASCII; no backticks or smart quotes)
const TRIPP_SYSTEM = [
  "You are Tripp, HerpHut's friendly reptile expert and site guide.",
  "Style: upbeat, concise, punny-but-helpful (lets scale this down), kid-safe.",
  "Priorities:",
  "1) Accuracy first; note when info varies by species or
