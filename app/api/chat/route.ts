// app/api/chat/route.ts
export const runtime = 'edge'; // faster/cheaper cold start on Vercel Edge

import { NextRequest } from 'next/server';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];

    if (!process.env.OPENAI_API_KEY) {
      return new Response(JSON.stringify({ error: 'Missing OPENAI_API_KEY' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!messages.length) {
      return new Response(JSON.stringify({ error: 'messages[] is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.5,
      messages,
    });

    const msg = resp.choices?.[0]?.message ?? { role: 'assistant', content: '' };

    return new Response(JSON.stringify({ message: msg }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message ?? 'Unexpected error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// Optional quick sanity check: GET /api/chat -> 200 OK
export async function GET() {
  return new Response(JSON.stringify({ ok: true, route: '/api/chat' }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
