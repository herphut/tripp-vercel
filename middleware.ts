// middleware.ts (root)
import { NextRequest, NextResponse } from 'next/server';
import { burstLimit } from './src/lib/rateLimits'; // adjust if located elsewhere

export const config = { matcher: ['/api/tripp/:path*'] };

// Comma-separated origins in ALLOWED_ORIGIN
const ORIGINS = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// Example wordlists — replace with your own
const BAD = ['f-bomb','c-bomb','slur1','slur2'];
const INJ = ['ignore previous instructions','reveal system prompt','developer mode','bypass safety'];

function setCors(res: NextResponse, origin: string) {
  if (origin && ORIGINS.includes(origin)) {
    res.headers.set('Access-Control-Allow-Origin', origin);
    res.headers.set('Vary', 'Origin');
  }
  res.headers.set('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.headers.set('Access-Control-Allow-Credentials', 'true');
  return res;
}

export async function middleware(req: NextRequest) {
  const origin = req.headers.get('origin') || '';

  // Preflight
  if (req.method === 'OPTIONS') {
    return setCors(new NextResponse(null, { status: 204 }), origin);
  }

  // Origin gate
  if (ORIGINS.length && origin && !ORIGINS.includes(origin)) {
    return NextResponse.json({ error: 'Forbidden origin' }, { status: 403 });
  }

  // Rate limit (no req.ip – use x-forwarded-for)
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '0.0.0.0';
  const key = `rl:${ip}:${req.nextUrl.pathname}`;

  const { allowed } = await burstLimit(key); // your helper returns an object
  if (!allowed) {
  return setCors(NextResponse.json({ error: 'Rate limit' }, { status: 429 }), origin);
  }
  
  // Validate JSON body (can read, but cannot modify)
  let body: any;
  try {
    body = await req.clone().json();
  } catch {
    return setCors(NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }), origin);
  }

  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const user = msgs.find((m: any) => m?.role === 'user');
  if (!user?.content || typeof user.content !== 'string') {
    return setCors(NextResponse.json({ error: 'Missing user content' }, { status: 400 }), origin);
  }

  const lower = user.content.toLowerCase();
  if (BAD.some(w => lower.includes(w))) {
    return setCors(NextResponse.json({ error: 'Blocked terms' }, { status: 400 }), origin);
  }
  if (INJ.some(w => lower.includes(w))) {
    return setCors(NextResponse.json({ error: 'Disallowed instruction' }, { status: 400 }), origin);
  }

  // We can’t rewrite the body here; optionally tag request for the route
  const res = NextResponse.next();
  res.headers.set('x-tripp-sanitized', '1'); // your route can check this
  return setCors(res, origin);
}
