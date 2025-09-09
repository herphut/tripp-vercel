// app/api/chat/route.ts
import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { LRUCache } from 'lru-cache';
import { z } from 'zod';

// ---------- config ----------
const RATE_LIMIT_REQUESTS = 20;        // requests per window
const RATE_LIMIT_WINDOW_MS = 60_000;   // 1 minute
const MAX_USER_MESSAGE_CHARS = 1000;   // keep it reasonable
// -----------------------------

// Simple fixed-window IP rate limiter using LRU (good enough for now)
type Counter = { count: number; resetAt: number };
const rlCache = new LRUCache<string, Counter>({
  max: 10_000, // up to 10k distinct IPs in memory
  ttl: RATE_LIMIT_WINDOW_MS, // auto-evict after window (safety)
});

// Extract a best-effort client IP from headers/req
import type { NextRequest } from 'next/server';

function getClientIp(req: NextRequest): string {
  const h = req.headers;
  const forwarded =
    h.get('x-vercel-forwarded-for') ??
    h.get('x-forwarded-for') ??
    h.get('x-real-ip');

  // If multiple IPs, the first is the client’s
  const ip = forwarded?.split(',')[0]?.trim();

  return ip ?? '0.0.0.0'; // safe fallback (dev/unknown)
}


function checkRateLimit(ip: string) {
  const now = Date.now();
  const bucket = rlCache.get(ip);
  if (!bucket) {
    rlCache.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS }, { ttl: RATE_LIMIT_WINDOW_MS });
    return { ok: true, remaining: RATE_LIMIT_REQUESTS - 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
  }
  if (now > bucket.resetAt) {
    rlCache.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS }, { ttl: RATE_LIMIT_WINDOW_MS });
    return { ok: true, remaining: RATE_LIMIT_REQUESTS - 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
  }
  if (bucket.count >= RATE_LIMIT_REQUESTS) {
    return { ok: false, remaining: 0, resetAt: bucket.resetAt };
  }
  bucket.count += 1;
  rlCache.set(ip, bucket, { ttl: bucket.resetAt - now });
  return { ok: true, remaining: RATE_LIMIT_REQUESTS - bucket.count, resetAt: bucket.resetAt };
}

// Validate incoming body
const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});
const BodySchema = z.object({
  messages: z.array(MessageSchema).min(1),
});

export async function POST(req: NextRequest) {
  // 1) Rate limit
  const ip = getClientIp(req);
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    return NextResponse.json(
      {
        reply:
          "Easy there, speedster! 🦎 I'm basking for a moment. Please try again in a bit.",
        usage: null,
        rate_limit: {
          limit: RATE_LIMIT_REQUESTS,
          remaining: rl.remaining,
          reset_ms: Math.max(rl.resetAt - Date.now(), 0),
        },
      },
      {
        status: 429,
        headers: {
          'X-RateLimit-Limit': String(RATE_LIMIT_REQUESTS),
          'X-RateLimit-Remaining': String(rl.remaining),
          'X-RateLimit-Reset': String(Math.ceil(rl.resetAt / 1000)),
        },
      }
    );
  }

  // 2) Parse + sanity checks
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
  if (!lastUser) {
    return NextResponse.json({ error: 'No user message provided' }, { status: 400 });
  }
  if (lastUser.content.length > MAX_USER_MESSAGE_CHARS) {
    return NextResponse.json(
      { error: `Message too long (>${MAX_USER_MESSAGE_CHARS} chars)` },
      { status: 413 }
    );
  }

  // 3) OpenAI call with graceful fallback
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Friendly on-brand fallback
    return NextResponse.json(
      {
        reply:
          "Oops—my heat lamp’s unplugged (API key missing). I’ll be back sunning soon. 🔌🦎",
        usage: null,
      },
      { status: 200 }
    );
  }

  const openai = new OpenAI({ apiKey });

  try {
    const system =
      "You are Tripp, the HerpHut AI. Be concise, helpful, and friendly. Use 1–4 sentences unless asked for detail.";

    // Call a budget-friendly model
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      messages: [
        { role: 'system', content: system },
        ...body.messages.map(m => ({ role: m.role, content: m.content })),
      ],
      max_tokens: 300,
    });

    const reply =
      resp.choices?.[0]?.message?.content?.trim() ||
      "I’m here! (But I couldn’t quite form a reply.)";

    return NextResponse.json(
      {
        reply,
        usage: resp.usage ?? null,
      },
      { status: 200 }
    );
  } catch (e) {
    // Friendly fallback on any error (timeouts, quota, network)
    return NextResponse.json(
      {
        reply:
          "Sorry—I’m off basking for a moment. Try me again in a few seconds! ☀️🦎",
        usage: null,
      },
      { status: 200 }
    );
  }
}
