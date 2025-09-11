// app/api/chat/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { sql } from "@vercel/postgres";
import { z } from "zod";
import { TRIPP_PROMPT } from "@/agents/trippPrompt";
import { rateLimit } from "@/lib/ratelimit";
import { checkModeration } from "@/lib/moderation";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const Msg = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});
const RequestBody = z.object({
  messages: z.array(Msg),
  session_id: z.string().uuid().optional(),
});
type Message = z.infer<typeof Msg>;

function clientKey(req: NextRequest): string {
  const xf = req.headers.get("x-forwarded-for");
  const ip = xf?.split(",")[0]?.trim() || "anon";
  return `${ip}:/api/chat`;
}

export async function POST(req: NextRequest) {
  // Rate limit
  const { allowed, remaining, reset } = await rateLimit(clientKey(req));
  const rl = {
    "X-RateLimit-Limit": "30",
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(reset),
  };
  if (!allowed) {
    return new NextResponse(
      JSON.stringify({
        error: "too_many_requests",
        message: "Whoa there, speedy gecko! Try again soon.",
      }),
      { status: 429, headers: { ...rl, "Content-Type": "application/json" } }
    );
  }

  // Parse body
  const parsed = RequestBody.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: rl });
  }
  const { messages, session_id } = parsed.data;

  // Moderation (last user)
  const lastUser: Message | undefined = [...messages].reverse().find(m => m.role === "user");
  const userText = lastUser?.content ?? "";
  const mod = await checkModeration(userText);
  if (mod.flagged) {
    return NextResponse.json(
      { error: "moderation_block", message: "I can’t help with that. Let’s keep it kid-safe! 🦎" },
      { status: 400, headers: rl }
    );
  }

  // Persist user message (last only to avoid duplicates)
  if (session_id && lastUser?.content) {
    await sql`INSERT INTO chat_messages (session_id, role, content) VALUES (${session_id}, 'user', ${lastUser.content})`;
    await sql`UPDATE chat_sessions SET updated_at = NOW() WHERE id = ${session_id}`;
  }

  // Model call (Responses API)
  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [{ role: "system", content: TRIPP_PROMPT }, ...messages],
  });
  const text = resp.output_text ?? "";

  // Persist assistant message
  if (session_id && text) {
    await sql`INSERT INTO chat_messages (session_id, role, content) VALUES (${session_id}, 'assistant', ${text})`;
    await sql`UPDATE chat_sessions SET updated_at = NOW() WHERE id = ${session_id}`;
  }

  return NextResponse.json({ text }, { status: 200, headers: rl });
}
