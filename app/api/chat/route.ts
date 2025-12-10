// app/api/chat/route.ts
export const runtime = "nodejs";
import "server-only";

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { asc, eq, sql } from "drizzle-orm";

import { db, schema } from "@/app/api/_lib/db/db";
import { TRIPP_PROMPT } from "@/app/api/_lib/trippPrompt";
import { getIdentity } from "@/app/api/_lib/identity";
import { auditLog } from "../_lib/audit";
import { readPrefs } from "@/app/api/_lib/prefs";

if (process.env.NODE_ENV !== "production") {
  process.env.OPENAI_API_KEY = "dummy-local-key";
}

const systemPrompt = TRIPP_PROMPT;

// ---------- Types ----------

type Role = "user" | "assistant" | "system";

type IncomingMessage = {
  role: Role;
  content: string;
};

type Body = {
  session_id?: string | null;
  userId?: string | null;
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

// ---------- MML-Core config ----------

const MML_CORE_URL =
  process.env.MML_CORE_URL || "http://localhost:3005/chat";

// ---------- Route ----------

export async function POST(req: NextRequest) {
  const t0 = Date.now();

  // ✅ Identity from canonical helper (no downgrade)
  const ident = await getIdentity(req);
  const clientId = ident.client_id ?? "webchat";
  const userId = ident.mode === "user" ? ident.user_id : null;
  const isAnon = ident.mode !== "user";

  // Parse body
  let body: Body;
  try {
    body = (await req.json()) as Body;
    console.log("📥 API CHAT BODY:", body);
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
      { status: 400, headers: { "Cache-Control": "no-store" } },
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
      { status: 400, headers: { "Cache-Control": "no-store" } },
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
      { status: 400, headers: { "Cache-Control": "no-store" } },
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
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Memory preference (for embeddings / long-term later)
  let memoryOptIn = true;
  if (userId) {
    try {
      memoryOptIn = await readPrefs(userId);
    } catch (err) {
      console.warn("readPrefs failed:", err);
    }
  }

  // For now:
  // - anon: persist
  // - logged-in, memory OFF: persist (30 day short-term)
  // - logged-in, memory ON: persist + eligible for future embeddings
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
              lastUser.content,
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

  // ---------- Call MML-Core instead of OpenAI ----------

  // Derive final user id that we send to MML-Core (can differ from DB userId in dev)
  const bodyUserId =
    (body as any).userId ?? (body as any).user_id ?? null;

  const cleanUserId =
    bodyUserId ??
    userId ??
    (process.env.NODE_ENV !== "production" ? "brian" : "anonymous");

  const cleanIsAnon =
    !userId && (cleanUserId === "anonymous" || !bodyUserId);

  console.log(
    "🧩 CHAT ROUTE → cleanUserId:",
    cleanUserId,
    "cleanIsAnon:",
    cleanIsAnon,
    "identityUserId:",
    userId,
  );

  try {
    const coreRes = await fetch(MML_CORE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: lastUser.content,
        history: conversation,
        userId: cleanUserId,
        metadata: {
          persona: "tripp",
          clientId,
          userId: cleanUserId,
          sessionId,
          memoryOptIn,
          ipHash,
          isAnon: cleanIsAnon,
        },
      }),
    });

    if (!coreRes.ok) {
      const text = await coreRes.text();
      console.error("Error from MML-Core:", text);

      await auditLog({
        route: "/api/chat:POST",
        status: 500,
        client_id: clientId,
        user_id: userId,
        session_id: sessionId,
        latency_ms: Date.now() - t0,
        error: "mml_core_error",
      });

      return NextResponse.json(
        { error: "mml_core_error" },
        {
          status: 500,
          headers: {
            "content-type": "application/json",
            "Cache-Control": "no-store",
          },
        },
      );
    }

    const coreData = (await coreRes.json()) as {
      message?: string;
      raw?: any;
    };

    const assistantText =
      coreData.message?.trim() ||
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
        ? [
            ...persistedHistory,
            { role: "assistant" as Role, content: assistantText },
          ]
        : [
            ...messages,
            { role: "assistant" as Role, content: assistantText },
          ];

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
      },
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
      },
    );
  }
}
