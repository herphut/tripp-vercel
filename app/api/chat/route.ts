// app/api/chat/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db/db";
import { asc, eq } from "drizzle-orm";
import OpenAI from "openai";
import { TRIPP_PROMPT } from "@/app/api/_lib/trippPrompt";
import { getIdentity } from "../_lib/persistence"; // keep your existing identity helper
import { auditLog } from "../_lib/audit";

// ✅ NEW: DB-driven prefs + JWT verify
import { readPrefs } from "@/src/lib/prefs";        // ensurePrefsRow/readPrefs as we created
import { verifyJwtRS256 } from "@/lib/jwtVerify";   // your existing verifier

const system = TRIPP_PROMPT;

type Msg = { role: "user" | "assistant" | "system"; content: string };
type Body = { session_id: string; user_id?: string | null; messages: Msg[] };

function haveKey(name: string) {
  const v = process.env[name];
  return !!v && v.trim() !== "";
}

// --- NEW: get user id from HH_ID_TOKEN (server-side) ---
async function userIdFromToken(req: NextRequest): Promise<string | null> {
  // cookie helper (raw fallback just in case)
  const rawCookie = req.cookies.get("HH_ID_TOKEN")?.value
    ?? (req.headers.get("cookie") || "")
      .split("; ")
      .find(s => s.startsWith("HH_ID_TOKEN="))
      ?.split("=")[1];

  if (!rawCookie) return null;
  try {
    const { payload } = await verifyJwtRS256(rawCookie);
    const uid = String(payload.sub || "");
    return uid || null;
  } catch {
    return null;
  }
}

// --- NEW: single source of truth for memory persistence ---
async function shouldPersist(req: NextRequest): Promise<boolean> {
  const uid = await userIdFromToken(req);
  if (!uid) return false;         // no user → no memory
  try {
    // readPrefs ensures row exists (defaults to false if missing)
    return await readPrefs(uid);
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const { client_id, user_id } = await getIdentity(req); // keep your diagnostic identity

  try {
    const body = (await req.json()) as Body;
    if (!body?.session_id || !Array.isArray(body.messages) || body.messages.length === 0) {
      await auditLog({
        route: "/api/chat:POST",
        status: 400,
        client_id,
        user_id,
        latency_ms: Date.now() - t0,
        error: "bad_request",
      });
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    // last user turn
    const last = [...body.messages].reverse().find((m) => m.role === "user");
    if (!last?.content) {
      await auditLog({
        route: "/api/chat:POST",
        status: 400,
        client_id,
        user_id,
        session_id: body.session_id,
        latency_ms: Date.now() - t0,
        error: "messages_required",
      });
      return NextResponse.json({ error: "messages_required" }, { status: 400 });
    }

    // 1) Decide if this session should persist messages (DB-driven)
    const persist = await shouldPersist(req);

    // 2) Ensure there is a chat_sessions row (insert-or-ignore; minimal)
    try {
      await db
        .insert(schema.chatSessions)
        .values({
          sessionId: body.session_id,
          clientId: client_id ?? "anon",   // fine; your table has NOT NULL on client_id
          userId: user_id ?? null,
        })
        .onConflictDoNothing();
    } catch {
      // best-effort; don't fail chat if this hiccups
    }

    // 3) Persist inbound user message only if memory is enabled
    if (persist) {
      try {
        await db.insert(schema.chatMessages).values({
          sessionId: body.session_id,
          role: "user",
          content: last.content,
        });
      } catch {
        // don't fail the request if storage hiccups
      }
    }

    // 4) No key? Echo path for local/dev
    if (!haveKey("OPENAI_API_KEY")) {
      const reply = `Echo: ${last.content}`;

      const messages = persist
        ? await db
            .select({
              role: schema.chatMessages.role,
              content: schema.chatMessages.content,
              created_at: schema.chatMessages.createdAt,
            })
            .from(schema.chatMessages)
            .where(eq(schema.chatMessages.sessionId, body.session_id))
            .orderBy(asc(schema.chatMessages.createdAt))
        : [
            { role: "user", content: last.content, created_at: new Date().toISOString() },
            { role: "assistant", content: reply, created_at: new Date().toISOString() },
          ];

      await auditLog({
        route: "/api/chat:POST",
        status: 200,
        client_id,
        user_id,
        session_id: body.session_id,
        latency_ms: Date.now() - t0,
      });

      return NextResponse.json({
        messages,
        diag: {
          openai_used: false,
          persisted: persist,
          reason: "missing OPENAI_API_KEY",
          memory_scope: user_id ? "user" : "session",
        },
      });
    }

    // 5) Call OpenAI
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: last.content },
      ],
    });

    const assistantText = resp.output_text?.trim() || "Sorry, I came up empty.";

    // 6) Persist assistant turn only if memory is enabled
    if (persist) {
      try {
        await db.insert(schema.chatMessages).values({
          sessionId: body.session_id,
          role: "assistant",
          content: assistantText,
        });
      } catch {
        // swallow storage issues
      }
    }

    // 7) Build response transcript
    const messages = persist
      ? await db
          .select({
            role: schema.chatMessages.role,
            content: schema.chatMessages.content,
            created_at: schema.chatMessages.createdAt,
          })
          .from(schema.chatMessages)
          .where(eq(schema.chatMessages.sessionId, body.session_id))
          .orderBy(asc(schema.chatMessages.createdAt))
      : [
          { role: "user", content: last.content, created_at: new Date().toISOString() },
          { role: "assistant", content: assistantText, created_at: new Date().toISOString() },
        ];

    await auditLog({
      route: "/api/chat:POST",
      status: 200,
      client_id,
      user_id,
      session_id: body.session_id,
      latency_ms: Date.now() - t0,
    });

    return NextResponse.json({
      messages,
      diag: {
        openai_used: true,
        persisted: persist,
        memory_scope: user_id ? "user" : "session",
      },
    });
  } catch (e: any) {
    await auditLog({
      route: "/api/chat:POST",
      status: 500,
      client_id,
      user_id,
      latency_ms: Date.now() - t0,
      error: String(e?.message ?? e),
    });
    return NextResponse.json(
      { error: "chat_route_failed", detail: "internal_error" },
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
}
