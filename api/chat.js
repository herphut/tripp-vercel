export const config = { runtime: 'edge' };

const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const allowOrigin = (origin) => !ALLOWED.length || ALLOWED.includes(origin);

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

  const { messages } = body || {};
  if (!Array.isArray(messages)) {
    return new Response('Bad Request', { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return new Response('Missing API key', { status: 500 });

  const payload = {
    model: 'gpt-4o-mini',
    messages,
    stream: false
  };

  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!r.ok || !r.body) {
    const text = await r.text().catch(() => '');
    return new Response(text || 'Upstream error', { status: r.status || 502 });
  }

  return new Response(r.body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Access-Control-Allow-Origin': origin
    }
  });
}
