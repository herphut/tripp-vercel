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
import { verifyJwtRS256 } from "@/app/api/_lib/jwtVerify";

const system = TRIPP_PROMPT;
const HISTORY_LIMIT = 30;

// ---- types ----
type TextTurn = { role: "system" | "user" | "assistant"; content: string };
type VisionPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "low" | "high" | "auto" };
type VisionTurn = { role: "user"; content: VisionPart[] };
type ToolTurn = { role: "tool"; content: any[] };
type ModelTurn = TextTurn | VisionTurn | ToolTurn;

type Msg = { role: "user" | "assistant" | "system"; content: string };
type Body = {
  session_id: string;
  user_id?: string | null;
  messages: Msg[];
  image_url?: string;
};

// ---- helpers ----
function makeTitleFrom(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const firstStop = cleaned.search(/[.!?]/);
  const base =
    (firstStop > 15 ? cleaned.slice(0, firstStop + 1) : cleaned).slice(0, 60);
  return base || "New chat";
}

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

async function shouldPersist(req: NextRequest): Promise<boolean> {
  const uid = await userIdFromToken(req);
  if (!uid) return false;
  try {
    return await readPrefs(uid);
  } catch (err) {
    console.warn("readPrefs failed:", err);
    return false;
  }
}

function haveKey(name: string) {
  const v = process.env[name];
  return !!v && v.trim() !== "";
}

function wantsImageTool(text: string | undefined) {
  if (!text) return false;
  return (
    /(^|\b)(generate|make|create|draw|render|design)\b.*\b(image|picture|sticker|logo|icon|art)\b/i.test(
      text
    ) || /\b(image_generation|image_generate|img:|#image)\b/i.test(text)
  );
}

function parseRequestedSize(
  text: string | undefined
): "1024x1024" | "1024x1536" | "1536x1024" | "auto" {
  if (!text) return "1024x1024";
  const m = text.match(/\b(1024x1024|1024x1536|1536x1024|auto)\b/i);
  return (m?.[1]?.toLowerCase() as any) || "1024x1024";
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const { client_id, user_id: identityUserId } = await getIdentity(req);
  const clientId = client_id ?? "webchat";
  const isGuest = !identityUserId;

  const softSessionId =
    req.cookies.get("SESSION_ID")?.value ||
    req.cookies.get("ANON_SESSION_ID")?.value ||
    null;

  try {
    const body = (await req.json()) as Body;
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

    let persist = await shouldPersist(req);

    // ensure chat_sessions row exists (best-effort)
    try {
      await db
        .insert(schema.chatSessions)
        .values({ sessionId, clientId, userId: identityUserId ?? null })
        .onConflictDoNothing();
    } catch (err) {
      console.warn("ensure chat_sessions failed:", err);
      await auditLog({
        route: "/api/chat:POST",
        status: 500,
        client_id: clientId,
        user_id: identityUserId,
        session_id: sessionId,
        latency_ms: Date.now() - t0,
        error: "ensure_chat_sessions_failed",
      });
    }

    // Save inbound user turn + set title/first_user_at once (only if persisting)
    let lastUserMessageId: number | null = null;
    let persistedHistory:
      | { role: string; content: string | null; created_at: Date }[]
      | null = null;

    if (persist) {
      try {
        const insertedUser = (await db
          .insert(schema.chatMessages)
          .values({
            sessionId,
            userId: identityUserId ?? null,
            role: "user",
            content: last.content,
          })
          .returning({ id: schema.chatMessages.id })) as any;

        lastUserMessageId =
          Array.isArray(insertedUser) ? insertedUser[0]?.id ?? null : insertedUser?.id ?? null;

        await db
          .update(schema.chatSessions)
          .set({
            firstUserAt: sql`COALESCE(${schema.chatSessions.firstUserAt}, NOW())`,
            title: sql`COALESCE(${schema.chatSessions.title}, ${makeTitleFrom(
              last.content
            )})`,
            updatedAt: new Date(),
            lastSeen: new Date(),
          })
          .where(eq(schema.chatSessions.sessionId, sessionId));

        // Load history AFTER saving user turn
        const history = await db
          .select({
            role: schema.chatMessages.role,
            content: schema.chatMessages.content,
            created_at: schema.chatMessages.createdAt,
          })
          .from(schema.chatMessages)
          .where(eq(schema.chatMessages.sessionId, sessionId))
          .orderBy(asc(schema.chatMessages.createdAt));

        persistedHistory = history as any[];
      } catch (dbErr) {
        const msg = String((dbErr as any)?.message ?? dbErr);
        console.error("DB insert user or session update failed:", dbErr);
        await auditLog({
          route: "/api/chat:POST",
          status: 500,
          client_id: clientId,
          user_id: identityUserId,
          session_id: sessionId,
          latency_ms: Date.now() - t0,
          error: `db_insert_user_failed: ${msg}`,
        });
        // avoid relying on persisted history if inserts failed
        persist = false;
      }
    }

    // Build model input
    const modelMessages: ModelTurn[] = [{ role: "system", content: system }];

    if (persist && persistedHistory) {
      const trimmed = persistedHistory
        .slice(-HISTORY_LIMIT)
        .map((h) => ({
          role: h.role as "user" | "assistant",
          content: h.content ?? "",
        }));
      modelMessages.push(...(trimmed as ModelTurn[]));
      // Ensure last user content is in the model messages:
      const needLast =
        trimmed.length === 0 ||
        trimmed[trimmed.length - 1].role !== "user" ||
        trimmed[trimmed.length - 1].content !== last.content;
      if (needLast) modelMessages.push({ role: "user", content: last.content });
    } else {
      const rolling = body.messages
        .filter(
          (m) =>
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string"
        )
        .slice(-HISTORY_LIMIT)
        .map((m) => ({ role: m.role, content: m.content }));
      modelMessages.push(...(rolling as ModelTurn[]));

      const needLast =
        rolling.length === 0 ||
        rolling[rolling.length - 1].role !== "user" ||
        rolling[rolling.length - 1].content !== last.content;
      if (needLast) modelMessages.push({ role: "user", content: last.content });
    }

    // If an image was attached AND user is logged in, add multimodal turn + log attachment
    const imageUrl = body?.image_url;
    if (imageUrl && !isGuest) {
      const visionPrompt =
        (typeof last?.content === "string" && last.content.trim()) ||
        "Please describe this image and note anything important.";

      (modelMessages as any[]).push({
        role: "user",
        content: [
          { type: "input_text", text: visionPrompt },
          { type: "input_image", image_url: imageUrl, detail: "auto" },
        ],
      });

      try {
        await db.insert(schema.attachments).values({
          sessionId,
          messageId: lastUserMessageId,
          userId: identityUserId ?? null,
          kind: "image",
          url: imageUrl,
          mime: null,
          sizeBytes: null,
          source: "upload",
        });
      } catch (attErr) {
        console.warn("Attachment insert failed:", attErr);
        await auditLog({
          route: "/api/chat:POST",
          status: 500,
          client_id: clientId,
          user_id: identityUserId,
          session_id: sessionId,
          latency_ms: Date.now() - t0,
          error: "attachment_insert_failed",
        });
      }
    }

    // Echo path for local dev without OpenAI
    const maybeAttached = typeof imageUrl === "string" && imageUrl ? imageUrl : null;
    if (!haveKey("OPENAI_API_KEY")) {
      const assistantText =
        `Echo: ${last.content}` +
        (maybeAttached ? `\n\n(Attached image: ${maybeAttached})` : "");

      const base = persistedHistory
        ? persistedHistory.map((h) => ({
            role: h.role,
            content: h.content ?? "",
            created_at: (h as any).created_at?.toISOString?.() ?? new Date().toISOString(),
          }))
        : modelMessages
            .filter((m: any) => m.role !== "system")
            .map((m: any) => ({
              role: m.role,
              content: typeof m.content === "string" ? m.content : last.content,
              created_at: new Date().toISOString(),
            }));

      const messagesOut = [
        ...base,
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
          diag: {
            openai_used: false,
            tools_enabled: false,
            persisted: persist,
            memory_scope: identityUserId ? "user" : "session",
          },
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // ---------- Model call ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

let assistantText: string | null = null;

// If user asked for an image, do NOT block here—return immediately with stream info.
if (!isGuest && wantsImageTool(last?.content)) {
  const size = parseRequestedSize(last?.content);
  const partials = 2; // 1–3 is a good range

  // Build the base transcript we’ll return right away
  const base = persistedHistory
    ? persistedHistory.map((h) => ({
        role: h.role,
        content: h.content ?? "",
        created_at:
          (h as any).created_at?.toISOString?.() ??
          (h as any).created_at ??
          new Date().toISOString(),
      }))
    : modelMessages
        .filter((m: any) => m.role !== "system")
        .map((m: any) => ({
          role: m.role,
          content: typeof m.content === "string" ? m.content : last.content,
          created_at: new Date().toISOString(),
        }));

  // Optional: persist a placeholder assistant message so a bubble appears instantly
  if (persist) {
    try {
      await db.insert(schema.chatMessages).values({
        sessionId,
        userId: identityUserId ?? null,
        role: "assistant",
        content:
          "Streaming your image… (this will refine in real time and finalize shortly)",
      });

      await db
        .update(schema.chatSessions)
        .set({ updatedAt: new Date(), lastSeen: new Date() })
        .where(eq(schema.chatSessions.sessionId, sessionId));
    } catch (assistErr) {
      console.warn("Failed to persist streaming placeholder:", assistErr);
    }
  }

  const placeholder = {
    role: "assistant",
    content: "Streaming your image… (you’ll see it refine live 🥚🦎)",
    created_at: new Date().toISOString(),
  };

  await auditLog({
    route: "/api/chat:POST",
    status: 200,
    client_id: clientId,
    user_id: identityUserId,
    session_id: sessionId,
    latency_ms: Date.now() - t0,
  });

  // Return immediately with SSE stream pointer for the client
  return NextResponse.json(
    {
      messages: [...base, placeholder],
      diag: {
        openai_used: true,
        tools_enabled: true,
        persisted: persist,
        memory_scope: identityUserId ? "user" : "session",
        stream: {
          kind: "image",
          url: `/api/image/stream?${new URLSearchParams({
            prompt: last.content,
            size,
            partials: String(partials),
          }).toString()}`,
          prompt: last.content,
          size,
          partials,
        },
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

// Otherwise: normal text model path (blocking)
try {
  const resp = await openai.responses.create({
    model: imageUrl ? "gpt-4o-mini" : "gpt-4.1-mini",
    input: modelMessages as any,
  });
  assistantText = resp.output_text?.trim() || "Sorry, I came up empty.";
} catch (err: any) {
  const msg = `openai_create_failed: ${String(err?.message || err)}`;
  await auditLog({
    route: "/api/chat:POST",
    status: 502,
    client_id: clientId,
    user_id: identityUserId,
    session_id: sessionId,
    latency_ms: Date.now() - t0,
    error: msg,
  });
  const expose = process.env.TRIPP_DEBUG === "1";
  return NextResponse.json(
    {
      error: "openai_unavailable",
      reason: expose ? msg : "model_error",
      detail: expose
        ? (err?.response?.data ?? err?.error ?? String(err))
        : undefined,
    },
    { status: 502, headers: { "Cache-Control": "no-store" } }
  );
}
// ---------- end model call ----------


    // persist assistant turn if memory on
    let assistantMessageId: number | null = null;
    if (persist && assistantText) {
      try {
        const insertedAssistant = (await db
          .insert(schema.chatMessages)
          .values({
            sessionId,
            userId: identityUserId ?? null,
            role: "assistant",
            content: assistantText,
          })
          .returning({ id: schema.chatMessages.id })) as any;

        assistantMessageId = Array.isArray(insertedAssistant)
          ? insertedAssistant[0]?.id ?? null
          : insertedAssistant?.id ?? null;

        await db
          .update(schema.chatSessions)
          .set({ updatedAt: new Date(), lastSeen: new Date() })
          .where(eq(schema.chatSessions.sessionId, sessionId));

        if (assistantMessageId) {
          try {
            await db
              .update(schema.attachments)
              .set({ messageId: assistantMessageId })
              .where(
                sql`${schema.attachments.sessionId} = ${sessionId} AND ${schema.attachments.messageId} IS NULL`
              );
          } catch (linkErr) {
            console.warn("Failed to backfill attachment.messageId:", linkErr);
            await auditLog({
              route: "/api/chat:POST",
              status: 500,
              client_id: clientId,
              user_id: identityUserId,
              session_id: sessionId,
              latency_ms: Date.now() - t0,
              error: "attachment_backfill_failed",
            });
          }
        }
      } catch (assistErr) {
        console.error("Failed to persist assistant message:", assistErr);
        await auditLog({
          route: "/api/chat:POST",
          status: 500,
          client_id: clientId,
          user_id: identityUserId,
          session_id: sessionId,
          latency_ms: Date.now() - t0,
          error: `db_insert_assistant_failed: ${String(
            (assistErr as any)?.message ?? assistErr
          )}`,
        });
      }
    }

    // ----------- Build response transcript (FIXED) -----------
    // Always include the assistant turn we just generated, even when using persistedHistory.
    const base = persistedHistory
      ? persistedHistory.map((h) => ({
          role: h.role,
          content: h.content ?? "",
          created_at:
            (h as any).created_at?.toISOString?.() ??
            (h as any).created_at ??
            new Date().toISOString(),
        }))
      : modelMessages
          .filter((m: any) => m.role !== "system")
          .map((m: any) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : last.content,
            created_at: new Date().toISOString(),
          }));

    const messages = [
      ...base,
      {
        role: "assistant",
        content: assistantText ?? "Sorry, I came up empty.",
        created_at: new Date().toISOString(),
      },
    ];
    // ---------------------------------------------------------

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
        diag: {
          openai_used: true,
          tools_enabled: false,
          persisted: persist,
          memory_scope: identityUserId ? "user" : "session",
        },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e: any) {
    await auditLog({
      route: "/api/chat:POST",
      status: 500,
      client_id: "webchat",
      user_id: null,
      session_id: null,
      latency_ms: Date.now() - t0,
      error: String(e?.message ?? e),
    });
    console.error("chat route failed:", e);
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
