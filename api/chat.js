export const config = { runtime: 'edge' };

const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const allowOrigin = (origin) => !ALLOWED.length || ALLOWED.includes(origin);

async function fetchWithRetry(url, opts, tries = 3) {
  let attempt = 0, lastRes, lastText = '';
  while (attempt < tries) {
    const res = await fetch(url, opts);
    if (res.status !== 429) return res;
    // read body so Vercel doesn't hold the stream open
    lastText = await res.text().catch(() => '');
    await new Promise(r => setTimeout(r, 800 * Math.pow(2, attempt))); // 800ms, 1600ms, 3200ms
    attempt++;
    lastRes = res;
  }
  // return last 429
  return new Response(lastText || 'Rate limited (429). Please retry shortly.', { status: 429 });
}

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

  const payload = {
    model: 'gpt-4o-mini',
    messages,
    // Keep it non-streaming for now so calls finish quicker under tight limits
    stream: true,
    max_tokens: 300,   // keep completions brief to avoid long holds
    temperature: 0.3
  };

  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
  const res = await fetchWithRetry(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return new Response(txt || 'Upstream error', { status: res.status || 502, headers: { 'Access-Control-Allow-Origin': origin } });
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  return new Response(text, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Access-Control-Allow-Origin': origin
    }
  });
}
