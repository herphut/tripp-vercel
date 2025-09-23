// app/api/chat/route.ts
import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";

import crypto from "crypto";
import { db, schema } from "@/db/db";
import { asc, eq, sql } from "drizzle-orm";
import OpenAI from "openai";
import { TRIPP_PROMPT } from "@/app/api/_lib/trippPrompt";
import { getIdentity } from "@/app/api/_lib/identity";
import { auditLog } from "../_lib/audit";

// DB-driven prefs + JWT verify
import { readPrefs } from "@/src/lib/prefs";
import { verifyJwtRS256 } from "@/lib/jwtVerify";

const system = TRIPP_PROMPT;
const HISTORY_LIMIT = 30;

function makeTitleFrom(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const firstStop = cleaned.search(/[.!?]/);
  const base = (firstStop > 15 ? cleaned.slice(0, firstStop + 1) : cleaned).slice(0, 60);
  return base || "New chat";
}

type Msg = { role: "user" | "assistant" | "system"; content: string };
type Body = { session_id: string; user_id?: string | null; messages: Msg[]; image_url?: string };

// --- user id from HH_ID_TOKEN (server-side) ---
async function userIdFromToken(req: NextRequest): Promise<string | null> {
  const raw =
    req.cookies.get("HH_ID_TOKEN")?.value ??
    (req.headers.get("cookie") || "")
      .split("; ")
      .find((s) => s.startsWith("HH_ID_TOKEN="))
      ?.split("=")[1];

  if (!raw) return null;
  try {
    const { payload } = await verifyJwtRS256(raw);
    const uid = String(payload.sub || "");
    return uid || null;
  } catch {
    return null;
  }
}

// --- single source of truth for memory persistence ---
async function shouldPersist(req: NextRequest): Promise<boolean> {
  const uid = await userIdFromToken(req);
  if (!uid) return false; // anon → no memory persistence
  try {
    return await readPrefs(uid); // boolean; defaults false if row missing
  } catch {
    return false;
  }
}

function haveKey(name: string) {
  const v = process.env[name];
  return !!v && v.trim() !== "";
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const { client_id, user_id: identityUserId } = await getIdentity(req);
  const clientId = client_id ?? "webchat";

  // soft session id from client-visible cookies (anon or helper cookie)
  const softSessionId =
    req.cookies.get("SESSION_ID")?.value ||
    req.cookies.get("ANON_SESSION_ID")?.value ||
    null;

  try {
    const body = (await req.json()) as Body;

    // prefer explicit session id from body; fall back to soft cookie identity
    const sessionId = body?.session_id || softSessionId || crypto.randomUUID();

    if (!Array.isArray(body?.messages) || body.messages.length === 0) {
      await auditLog({
        route: "/api/chat:POST",
        status: 400,
        client_id: clientId,
        user_id: identityUserId,
        session_id: sessionId,
        latency_ms: Date.now() - t0,
        error: "bad_request",
      });
      return NextResponse.json(
        { error: "bad_request" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    // last user turn (required)
    const last = [...body.messages].reverse().find((m) => m.role === "user");
    if (!last?.content) {
      await auditLog({
        route: "/api/chat:POST",
        status: 400,
        client_id: clientId,
        user_id: identityUserId,
        session_id: sessionId,
        latency_ms: Date.now() - t0,
        error: "messages_required",
      });
      return NextResponse.json(
        { error: "messages_required" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Decide persistence (consent-aware; anon => false)
    const persist = await shouldPersist(req);

    // Ensure a chat_sessions row exists (best-effort)
    try {
      await db
        .insert(schema.chatSessions)
        .values({
          sessionId,
          clientId,
          userId: identityUserId ?? null,
        })
        .onConflictDoNothing();
    } catch {}

    // If persisting, store the inbound user message (with user_id) + set title/first_user_at once
    if (persist) {
      try {
        await db.insert(schema.chatMessages).values({
          sessionId,
          userId: identityUserId ?? null,
          role: "user",
          content: last.content,
        });

        await db
          .update(schema.chatSessions)
          .set({
            firstUserAt: sql`COALESCE(${schema.chatSessions.firstUserAt}, NOW())`,
            title: sql`COALESCE(${schema.chatSessions.title}, ${makeTitleFrom(last.content)})`,
            updatedAt: new Date(),
            lastSeen: new Date(),
          })
          .where(eq(schema.chatSessions.sessionId, sessionId));
      } catch {}
    }

    // Build model input
    const modelMessages: { role: "system" | "user" | "assistant"; content: any }[] = [
      { role: "system", content: system },
    ];

    if (persist) {
      // Use DB transcript (already includes just-inserted user turn)
      const history = await db
        .select({
          role: schema.chatMessages.role,
          content: schema.chatMessages.content,
          created_at: schema.chatMessages.createdAt,
        })
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.sessionId, sessionId))
        .orderBy(asc(schema.chatMessages.createdAt));

      const trimmed = history
        .slice(-HISTORY_LIMIT)
        .map((h) => ({ role: h.role as "user" | "assistant", content: h.content ?? "" }));

      modelMessages.push(...trimmed);
    } else {
      // Anon or memory off → use client-provided rolling window
      const rolling = body.messages
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-HISTORY_LIMIT)
        .map((m) => ({ role: m.role, content: m.content }));

      modelMessages.push(...(rolling as any));

      // Ensure the latest user turn is last
      const needLast =
        rolling.length === 0 ||
        rolling[rolling.length - 1].role !== "user" ||
        rolling[rolling.length - 1].content !== last.content;
      if (needLast) modelMessages.push({ role: "user", content: last.content });
    }

    // Echo path (helpful in local/dev)
    const maybeAttachedImageForEcho =
      (typeof body?.image_url === "string" && body.image_url) || null;

    if (!haveKey("OPENAI_API_KEY")) {
      const assistantText =
        `Echo: ${last.content}` +
        (maybeAttachedImageForEcho ? `\n\n(Attached image: ${maybeAttachedImageForEcho})` : "");

      const messagesOut =
        persist
          ? await db
              .select({
                role: schema.chatMessages.role,
                content: schema.chatMessages.content,
                created_at: schema.chatMessages.createdAt,
              })
              .from(schema.chatMessages)
              .where(eq(schema.chatMessages.sessionId, sessionId))
              .orderBy(asc(schema.chatMessages.createdAt))
          : [
              ...modelMessages
                .filter((m) => m.role !== "system")
                .map((m) => ({
                  role: m.role,
                  content: m.content,
                  created_at: new Date().toISOString(),
                })),
              { role: "assistant", content: assistantText, created_at: new Date().toISOString() },
            ];

      await auditLog({
        route: "/api/chat:POST",
        status: 200,
        client_id: clientId,
        user_id: identityUserId,
        session_id: sessionId,
        latency_ms: Date.now() - t0,
      });

      return NextResponse.json(
        {
          messages: messagesOut,
          diag: { openai_used: false, persisted: persist, memory_scope: identityUserId ? "user" : "session" },
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // --- If an image was attached, append a multimodal user turn ---
    const imageUrl = body?.image_url;
    if (imageUrl) {
      const visionPrompt =
        (typeof last?.content === "string" && last.content.trim()) ||
        "Please describe this image and note anything important.";

      (modelMessages as any[]).push({
        role: "user",
        content: [
          { type: "input_text", text: visionPrompt },
          { type: "input_image", image_url: imageUrl },
        ],
      });
    }

    // Call OpenAI (use a vision-capable model when an image is present)
    let assistantText = "Sorry, I came up empty.";
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
      const resp = await openai.responses.create({
        model: imageUrl ? "gpt-4o-mini" : "gpt-4.1-mini",
        input: modelMessages as any, // mixed text + multimodal is OK for Responses API
      });
      assistantText = resp.output_text?.trim() || assistantText;
    } catch (err: any) {
      await auditLog({
        route: "/api/chat:POST",
        status: 502,
        client_id: clientId,
        user_id: identityUserId,
        session_id: sessionId,
        latency_ms: Date.now() - t0,
        error: `openai_error: ${String(err?.message || err)}`,
      });
      return NextResponse.json(
        { error: "openai_unavailable", message: "Model call failed. Try again shortly." },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Persist assistant only if memory is enabled
    if (persist) {
      try {
        await db.insert(schema.chatMessages).values({
          sessionId,
          userId: identityUserId ?? null,
          role: "assistant",
          content: assistantText,
        });

        // keep session timestamps fresh
        await db
          .update(schema.chatSessions)
          .set({
            updatedAt: new Date(),
            lastSeen: new Date(),
          })
          .where(eq(schema.chatSessions.sessionId, sessionId));
      } catch {}
    }

    // Build the response transcript
    const messages =
      persist
        ? await db
            .select({
              role: schema.chatMessages.role,
              content: schema.chatMessages.content,
              created_at: schema.chatMessages.createdAt,
            })
            .from(schema.chatMessages)
            .where(eq(schema.chatMessages.sessionId, sessionId))
            .orderBy(asc(schema.chatMessages.createdAt))
        : [
            ...modelMessages
              .filter((m) => m.role !== "system")
              .map((m) => ({
                role: m.role,
                content: m.content,
                created_at: new Date().toISOString(),
              })),
            { role: "assistant", content: assistantText, created_at: new Date().toISOString() },
          ];

    await auditLog({
      route: "/api/chat:POST",
      status: 200,
      client_id: clientId,
      user_id: identityUserId,
      session_id: sessionId,
      latency_ms: Date.now() - t0,
    });

    return NextResponse.json(
      {
        messages,
        diag: { openai_used: true, persisted: persist, memory_scope: identityUserId ? "user" : "session" },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e: any) {
    await auditLog({
      route: "/api/chat:POST",
      status: 500,
      client_id: clientId,
      user_id: identityUserId,
      session_id: null,
      latency_ms: Date.now() - t0,
      error: String(e?.message ?? e),
    });
    return NextResponse.json(
      { error: "chat_route_failed", detail: "internal_error" },
      { status: 500, headers: { "content-type": "application/json", "Cache-Control": "no-store" } }
    );
  }
}

