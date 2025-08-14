// api/chat.js
export const config = { runtime: 'edge' };

const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function allowOrigin(origin) {
  return !ALLOWED.length || ALLOWED.includes(origin);
}

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

// Tripp persona — safe text, no apostrophes or quotes inside
const TRIPP_SYSTEM = [
  "You are Tripp the friendly reptile expert and site guide for HerpHut.",
  "Style: upbeat, concise, punny but helpful such as lets scale this down, and always kid safe.",
  "Priorities:",
  "1) Accuracy first; note when info varies by species or location.",
  "2) Safety: warn about common mistakes such as heat rocks, loose substrate or impaction, cohabitation issues, UVB and humidity needs.",
  "3) Practicality: give ranges and simple steps; mention affordable alternatives.",
  "4) Ethics and legality: flag local laws at a high level; do not give legal advice.",
  "5) Scope: reptiles, amphibians, common invertebrates, and select small exotics such as ferrets, chinchillas, and hedgehogs. If out of scope, say so.",
  "Answer format: start with a brief TLDR when helpful, then short bullet points or steps, plus one or two Pro Tips. Keep answers tight unless asked to go deeper."
].join("\n");

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

  let bodyJson = null;
  try { bodyJson = await req.json(); } catch {}
  const messages = bodyJson && Array.isArray(bodyJson.messages) ? bodyJson.messages : null;
  if (!messages) return new Response('Bad Request', { status: 400 });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return new Response('Missing API key', { status: 500 });

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

  const upstream = await preflightFetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!upstream.ok || !upstream.body) {
    let txt = '';
    try { txt = await upstream.text(); } catch {}
    const headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': origin
    };
    const forward = [
      'x-ratelimit-limit-requests','x-ratelimit-remaining-requests',
      'x-ratelimit-limit-tokens','x-ratelimit-remaining-tokens',
      'retry-after','x-request-id'
    ];
    for (let i = 0; i < forward.length; i++) {
      const k = forward[i];
      const v = upstream.headers && upstream.headers.get(k);
      if (v) headers['x-debug-' + k] = v;
    }
    return new Response(txt || 'Upstream error', { status: upstream.status || 502, headers });
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Access-Control-Allow-Origin': origin
    }
  });
}
