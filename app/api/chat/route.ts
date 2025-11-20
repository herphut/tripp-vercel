export const runtime = "nodejs";
import "server-only";

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import OpenAI from "openai";
import { asc, eq, sql } from "drizzle-orm";

import { db, schema } from "@/app/api/_lib/db/db";
import { TRIPP_PROMPT } from "@/app/api/_lib/trippPrompt";
import { getIdentity } from "@/app/api/_lib/identity";
import { auditLog } from "../_lib/audit";
import { readPrefs } from "@/app/api/_lib/prefs";

const systemPrompt = TRIPP_PROMPT;

// ---------- Types ----------

type Role = "user" | "assistant" | "system";

type IncomingMessage = {
  role: Role;
  content: string;
};

type Body = {
  session_id?: string | null;
  user_id?: string | null;
  messages?: IncomingMessage[];
  image_url?: string | null;
};

// ---------- Helpers ----------

function haveKey(name: string) {
  const v = process.env[name];
  return !!v && v.trim() !== "";
}

function getClientIp(req: NextRequest): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  // @ts-ignore - NextRequest.ip exists in many runtimes
  if ((req as any).ip) return String((req as any).ip);
  return null;
}

function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  const salt = process.env.IP_HASH_SALT || "";
  if (!salt) return null;
  return crypto.createHash("sha256").update(ip + salt).digest("hex");
}

function makeTitleFrom(text: string): string {
  const trimmed = (text || "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "New chat";
  if (trimmed.length <= 80) return trimmed;
  return trimmed.slice(0, 77) + "...";
}

// ---------- OpenAI client ----------

const openai = haveKey("OPENAI_API_KEY")
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ---------- Route ----------

export async function POST(req: NextRequest) {
  const t0 = Date.now();

  // Identity from JWT / headers via your helper
  const { client_id, user_id: identityUserId } = await getIdentity(req);
  const clientId = client_id ?? "webchat";
  const userId = identityUserId || null;
  const isAnon = !userId;

  if (!openai) {
    await auditLog({
      route: "/api/chat:POST",
      status: 500,
      client_id: clientId,
      user_id: userId,
      session_id: null,
      latency_ms: Date.now() - t0,
      error: "missing_openai_key",
    });
    return NextResponse.json(
      { error: "server_not_configured" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Parse body
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    await auditLog({
      route: "/api/chat:POST",
      status: 400,
      client_id: clientId,
      user_id: userId,
      session_id: null,
      latency_ms: Date.now() - t0,
      error: "invalid_json",
    });
    return NextResponse.json(
      { error: "bad_request" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const sessionId = body.session_id || null;
  if (!sessionId) {
    await auditLog({
      route: "/api/chat:POST",
      status: 400,
      client_id: clientId,
      user_id: userId,
      session_id: null,
      latency_ms: Date.now() - t0,
      error: "missing_session_id",
    });
    return NextResponse.json(
      { error: "missing_session_id" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    await auditLog({
      route: "/api/chat:POST",
      status: 400,
      client_id: clientId,
      user_id: userId,
      session_id: sessionId,
      latency_ms: Date.now() - t0,
      error: "messages_required",
    });
    return NextResponse.json(
      { error: "messages_required" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser || !lastUser.content?.trim()) {
    await auditLog({
      route: "/api/chat:POST",
      status: 400,
      client_id: clientId,
      user_id: userId,
      session_id: sessionId,
      latency_ms: Date.now() - t0,
      error: "messages_required",
    });
    return NextResponse.json(
      { error: "messages_required" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Read memory preference – used later for embeddings/long-term memory,
  // but NOT for basic short-term logging.
  let memoryOptIn = false;
  if (userId) {
    try {
      memoryOptIn = await readPrefs(userId);
    } catch (err) {
      console.warn("readPrefs failed:", err);
    }
  }

  // For our new design:
  // - anon: persist
  // - logged-in, memory OFF: persist (30-day short-term log)
  // - logged-in, memory ON: persist AND later eligible for embeddings
  const shouldPersist = true;

  const ip = getClientIp(req);
  const ipHash = hashIp(ip);

  let persistedHistory: { role: Role; content: string }[] | null = null;

  try {
    if (shouldPersist) {
      const now = new Date();

      // Ensure chat_sessions row exists
      const existing = await db
        .select({ id: schema.chatSessions.id })
        .from(schema.chatSessions)
        .where(eq(schema.chatSessions.sessionId, sessionId))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(schema.chatSessions).values({
          sessionId,
          clientId,
          userId: userId ?? null,
          tier: "free",
          createdAt: now,
          updatedAt: now,
          lastSeen: now,
          ipHash: ipHash ?? null,
        });
      } else {
        await db
          .update(schema.chatSessions)
          .set({
            userId: userId ?? null,
            updatedAt: now,
            lastSeen: now,
            ipHash: ipHash ?? null,
          })
          .where(eq(schema.chatSessions.sessionId, sessionId));
      }

      // Save inbound user turn
      await db.insert(schema.chatMessages).values({
        sessionId,
        userId: userId ?? null,
        role: "user",
        content: lastUser.content,
        createdAt: new Date(),
      });

      // Load full history for this session
      const historyRows = await db
        .select({
          role: schema.chatMessages.role,
          content: schema.chatMessages.content,
        })
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.sessionId, sessionId))
        .orderBy(asc(schema.chatMessages.createdAt));

      persistedHistory = historyRows.map((h) => ({
        role: (h.role as Role) ?? "user",
        content: h.content ?? "",
      }));

      // Optional: set title/first_user_at on first turn
      if (existing.length === 0) {
        await db
          .update(schema.chatSessions)
          .set({
            firstUserAt: sql`COALESCE(${schema.chatSessions.firstUserAt}, NOW())`,
            title: sql`COALESCE(${schema.chatSessions.title}, ${makeTitleFrom(
              lastUser.content
            )})`,
          })
          .where(eq(schema.chatSessions.sessionId, sessionId));
      }
    }
  } catch (dbErr) {
    console.error("chat route DB error:", dbErr);
    // If DB fails, we still answer, just without persisted history
    persistedHistory = null;
  }

  // ---------- Build model messages ----------

  const conversation: { role: Role; content: string }[] = [];
  conversation.push({ role: "system", content: systemPrompt });

  if (persistedHistory && persistedHistory.length > 0) {
    conversation.push(...persistedHistory);
  } else {
    for (const m of messages) {
      if (!m.content) continue;
      const role: Role = m.role === "system" ? "assistant" : m.role;
      conversation.push({ role, content: m.content });
    }
  }

  if (body.image_url) {
    conversation.push({
      role: "user",
      content: `Note: The user has attached an image at this URL: ${body.image_url}`,
    });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.TRIPP_MODEL || "gpt-4.1-mini",
      messages: conversation.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: 0.7,
    });

    const assistantText =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Sorry, I couldn’t think of a reply.";

    if (shouldPersist) {
      try {
        await db.insert(schema.chatMessages).values({
          sessionId,
          userId: userId ?? null,
          role: "assistant",
          content: assistantText,
          createdAt: new Date(),
        });
      } catch (assistErr) {
        console.error("Failed to persist assistant message:", assistErr);
      }
    }

    const clientMessages =
      persistedHistory && shouldPersist
        ? [...persistedHistory, { role: "assistant" as Role, content: assistantText }]
        : [...messages, { role: "assistant" as Role, content: assistantText }];

    await auditLog({
      route: "/api/chat:POST",
      status: 200,
      client_id: clientId,
      user_id: userId,
      session_id: sessionId,
      latency_ms: Date.now() - t0,
      error: null,
    });

    return NextResponse.json(
      { messages: clientMessages },
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (e: any) {
    const errMsg = String(e?.message || e);
    console.error("chat route failed:", e);

    await auditLog({
      route: "/api/chat:POST",
      status: 500,
      client_id: clientId,
      user_id: userId,
      session_id: sessionId,
      latency_ms: Date.now() - t0,
      error: errMsg,
    });

    return NextResponse.json(
      { error: "chat_route_failed", detail: "internal_error" },
      {
        status: 500,
        headers: {
          "content-type": "application/json",
          "Cache-Control": "no-store",
        },
      }
    );
  }
}
