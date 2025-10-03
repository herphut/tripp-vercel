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

function extractImageBase64s(resp: any): string[] {
  const out: string[] = [];
  if (!resp) return out;

  // The Responses payload can surface images either as top-level generation calls
  // or as assistant message content blocks. We check both shapes.
  for (const item of resp.output ?? []) {
    // Case A: built-in tool call surfaced directly
    if (item?.type === "image_generation_call" && item?.result) {
      out.push(String(item.result));
    }
    // Case B: assistant message blocks
    for (const part of item?.content ?? []) {
      const maybe =
        part?.image_base64 ?? part?.base64 ?? part?.data ?? part?.result ?? null;
      if (typeof maybe === "string" && maybe.length > 1000) out.push(maybe);
    }
  }

  // de-dup
  return Array.from(new Set(out));
}


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

// ---- built-in tools allowlist (env: TRIPP_BUILTIN_TOOLS=image_generation,web_search) ----
function builtInToolsForRequest(opts: { isGuest: boolean; lastUserText: string | undefined }) {
  if (process.env.TRIPP_DISABLE_TOOLS === "1") return undefined;
  if (opts.isGuest) return undefined; // never expose tools to guests

  // parse allowlist
  const allowEnv = (process.env.TRIPP_BUILTIN_TOOLS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowEnv.length === 0) return undefined;

  // Only expose image generation when user actually asks for an image
  const tools: any[] = [];
  if (allowEnv.includes("image_generation") && wantsImageTool(opts.lastUserText)) {
    tools.push({ type: "image_generation" as const });
  }

  // (Later you can add: if (allowEnv.includes("web_search")) tools.push({ type: "web_search" as const }); )

  return tools.length ? tools : undefined;
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

   // ---------- Built-in tools path ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const toolsForModel = builtInToolsForRequest({
  isGuest,
  lastUserText: last?.content,
});

const askedForImage =
  !!toolsForModel?.some((t: any) => t?.type === "image_generation");

// choose model: use gpt-image-1 when asking to generate an image
const modelName = askedForImage
  ? "gpt-image-1"
  : (imageUrl ? "gpt-4o-mini" : "gpt-4.1-mini");

const maxToolHops = Math.max(
  0,
  Number(process.env.TRIPP_MAX_TOOLS_PER_CHAT || 1)
);

// first call
let resp: any;
try {
  resp = await openai.responses.create({
    model: modelName,
    input: modelMessages as any,
    ...(toolsForModel
      ? { tools: toolsForModel as any, tool_choice: "auto" as const }
      : {}),
  });
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

    // ---------- end built-in tools path ----------

    let assistantText = resp.output_text?.trim() || "Sorry, I came up empty.";

if (askedForImage) {
  const b64s = extractImageBase64s(resp);
  if (b64s.length) {
    const dataUrl = `data:image/png;base64,${b64s[0]}`;
    // Keep it simple for now: return the data URL in the assistant text.
    assistantText = `Here’s your image (data URL below). Copy to a new tab to view or save:\n\n${dataUrl}`;
  }
}


    // persist assistant turn if memory on
    if (persist) {
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
        messages,
        diag: {
          openai_used: true,
          tools_enabled: !!toolsForModel,
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
