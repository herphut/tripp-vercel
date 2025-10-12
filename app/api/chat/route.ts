// app/api/chat/route.ts
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
  } catch {
    return false;
  }
}

function haveKey(name: string) {
  const v = process.env[name];
  return !!v && v.trim() !== "";
}

// VERY conservative “does this look like an explicit image request?”
function wantsImageTool(text: string | undefined) {
  if (!text) return false;
  return (
    /(^|\b)(generate|make|create|draw|render|design)\b.*\b(image|picture|sticker|logo|icon|art)\b/i.test(
      text
    ) || /\b(image_generation|image_generate|img:|#image)\b/i.test(text)
  );
}

function extractImageBase64s(resp: any): string[] {
  const out: string[] = [];
  for (const item of resp?.output ?? []) {
    // Built-in image tool output
    if (item?.type === "image_generation_call" && item?.result) {
      out.push(String(item.result));
    }
    // Assistant blocks that carry images
    for (const part of item?.content ?? []) {
      const maybe =
        part?.image_base64 ?? part?.base64 ?? part?.data ?? part?.result ?? null;
      if (typeof maybe === "string" && maybe.length > 1000) out.push(maybe);
    }
  }
  return Array.from(new Set(out));
}


// Extract a requested size if the user says “512x512”, else default 1024x1024
function parseRequestedSize(text: string | undefined): "512x512" | "1024x1024" {
  if (!text) return "512x512";
  const m = text.match(/\b(512x512|1024x1024)\b/i);
  return (m?.[1]?.toLowerCase() as any) || "512x512";
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const { client_id, user_id: identityUserId } = await getIdentity(req);
  const clientId = client_id ?? "webchat";
  const isGuest = !identityUserId;

  // soft session id fallback for dev
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

    const persist = await shouldPersist(req);

    // ensure chat_sessions row exists (best-effort)
    try {
      await db
        .insert(schema.chatSessions)
        .values({ sessionId, clientId, userId: identityUserId ?? null })
        .onConflictDoNothing();
    } catch {}

    // save inbound user turn + set title/first_user_at once (only if persisting)
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
            title: sql`COALESCE(${schema.chatSessions.title}, ${makeTitleFrom(
              last.content
            )})`,
            updatedAt: new Date(),
            lastSeen: new Date(),
          })
          .where(eq(schema.chatSessions.sessionId, sessionId));
      } catch {}
    }

    // Build model input
    const modelMessages: ModelTurn[] = [{ role: "system", content: system }];

    if (persist) {
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
        .map((h) => ({
          role: h.role as "user" | "assistant",
          content: h.content ?? "",
        }));

      modelMessages.push(...(trimmed as ModelTurn[]));
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
          messageId: null,
          userId: identityUserId ?? null,
          kind: "image",
          url: imageUrl,
          mime: null,
          sizeBytes: null,
          source: "upload",
        });
      } catch {}
    }

    // Echo path for local dev without OpenAI
    const maybeAttached = typeof imageUrl === "string" && imageUrl ? imageUrl : null;
    if (!haveKey("OPENAI_API_KEY")) {
      const assistantText =
        `Echo: ${last.content}` +
        (maybeAttached ? `\n\n(Attached image: ${maybeAttached})` : "");

      const messagesOut = persist
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
              .filter((m: any) => m.role !== "system")
              .map((m: any) => ({
                role: m.role,
                content: (m as any).content,
                created_at: new Date().toISOString(),
              })),
            {
              role: "assistant",
              content: assistantText,
              created_at: new Date().toISOString(),
            },
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

    // ---------- Model call (images if asked, otherwise Responses) ----------
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

    let resp: any = null;
    let assistantText: string | null = null;

    if (!isGuest && wantsImageTool(last?.content)) {
      // Direct Images API (Responses API does NOT support gpt-image-1)
      try {
        const size = parseRequestedSize(last?.content);
        const img = await openai.images.generate({
          model: "gpt-image-1",
          prompt: last.content,
          size,
        });

        const b64 = img.data?.[0]?.b64_json;
        if (b64 && typeof b64 === "string") {
          assistantText = `Here is your image:\n\ndata:image/png;base64,${b64}`;
        } else {
          assistantText =
            "I tried to generate an image but didn’t receive data back. Please try again.";
        }
      } catch (err: any) {
        const msg = err?.response?.data?.error?.message || err?.message || String(err);
        await auditLog({
          route: "/api/chat:POST",
          status: 502,
          client_id: clientId,
          user_id: identityUserId,
          session_id: sessionId,
          latency_ms: Date.now() - t0,
          error: `images_api_error: ${msg}`,
        });
        return NextResponse.json(
          { error: "openai_unavailable", reason: "images_api_error", detail: msg },
          { status: 502, headers: { "Cache-Control": "no-store" } }
        );
      }
    } else {
      // Normal chat path via Responses API
      try {
        resp = await openai.responses.create({
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
    }
    // ---------- end model call ----------

    // persist assistant turn if memory on
    if (persist && assistantText) {
      try {
        await db.insert(schema.chatMessages).values({
          sessionId,
          userId: identityUserId ?? null,
          role: "assistant",
          content: assistantText,
        });

        await db
          .update(schema.chatSessions)
          .set({ updatedAt: new Date(), lastSeen: new Date() })
          .where(eq(schema.chatSessions.sessionId, sessionId));
      } catch {}
    }

    // build response transcript
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
              .filter((m: any) => m.role !== "system")
              .map((m: any) => ({
                role: m.role,
                content:
                  typeof m.content === "string" ? m.content : last.content,
                created_at: new Date().toISOString(),
              })),
            {
              role: "assistant",
              content: assistantText ?? "Sorry, I came up empty.",
              created_at: new Date().toISOString(),
            },
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
        diag: {
          openai_used: true,
          tools_enabled: false, // we’re not exposing custom tools in this route
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
      client_id: clientId,
      user_id: identityUserId,
      session_id: null,
      latency_ms: Date.now() - t0,
      error: String(e?.message ?? e),
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
