// app/api/chat/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db/db";
import { TRIPP_PROMPT } from "../../trippPrompt";
import { asc, eq } from "drizzle-orm";
import OpenAI from "openai";

type Msg = { role: "user" | "assistant" | "system"; content: string };
type Body = { session_id: string; user_id?: string | null; messages: Msg[] };

function haveKey(name: string) {
  const v = process.env[name];
  return !!v && v.trim() !== "";
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Body;
    if (!body?.session_id || !Array.isArray(body.messages) || body.messages.length === 0) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const last = [...body.messages].reverse().find(m => m.role === "user");
    if (!last?.content) {
      return NextResponse.json({ error: "messages_required" }, { status: 400 });
    }

    // Persist the user message
    await db.insert(schema.chatMessages).values({
      sessionId: body.session_id,
      role: "user",
      content: last.content,
    });

    // If no key, return an echo so local dev still works
    if (!haveKey("OPENAI_API_KEY")) {
      const reply = `Echo: ${last.content}`;
      return NextResponse.json({
        messages: [
          ...(await db
            .select({
              role: schema.chatMessages.role,
              content: schema.chatMessages.content,
              created_at: schema.chatMessages.createdAt,
            })
            .from(schema.chatMessages)
            .where(eq(schema.chatMessages.sessionId, body.session_id))
            .orderBy(asc(schema.chatMessages.createdAt))),
          { role: "assistant", content: reply, created_at: new Date().toISOString() },
        ],
        diag: { openai_used: false, reason: "missing OPENAI_API_KEY" },
      });
    }

    // Call OpenAI
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

    // Use the full Tripp system prompt
    const system = TRIPP_PROMPT.trim();
    const userText = last.content;


    // Responses API (works with openai >= 4.x)
    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: userText },
      ],
    });

    const assistantText = resp.output_text?.trim() || "Sorry, I came up empty.";

    // Persist assistant message
    await db.insert(schema.chatMessages).values({
      sessionId: body.session_id,
      role: "assistant",
      content: assistantText,
    });

    // Read back conversation (proves select still happy)
    const rows = await db
      .select({
        role: schema.chatMessages.role,
        content: schema.chatMessages.content,
        created_at: schema.chatMessages.createdAt,
      })
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.sessionId, body.session_id))
      .orderBy(asc(schema.chatMessages.createdAt));

    return NextResponse.json({ messages: rows, diag: { openai_used: true } });
  } catch (e: any) {
    console.error("[chat] fatal", e);
    return NextResponse.json(
      { error: "chat_route_failed", detail: String(e?.message ?? e) },
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
}
