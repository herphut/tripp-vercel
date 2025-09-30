// app/api/chat/route.ts
export const runtime = "nodejs";
import "server-only";

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import OpenAI from "openai";
import { asc, eq, sql } from "drizzle-orm";

// NOTE: adjust these import paths if your file layout differs
import { db, schema } from "@/app/api/_lib/db/db";
import { TRIPP_PROMPT } from "@/app/api/_lib/trippPrompt";
import { getIdentity } from "@/app/api/_lib/identity";
import { auditLog } from "../_lib/audit";
import { readPrefs } from "@/app/api/_lib/prefs";
import { verifyJwtRS256 } from "@/app/api/_lib/jwtVerify";

// ✅ tools + validator (paths assume you used my earlier placement)
import { trippTools } from "@/app/api/_lib/tools";
import {
  validateToolDefinitions,
  validateInvocation,
  toolsToFunctions,
} from "@/app/api/_lib/toolvalidator";

const system = TRIPP_PROMPT;
const HISTORY_LIMIT = 30;

// Precompile tool validators once (at module load)
const TOOL_DISABLED = process.env.TRIPP_DISABLE_TOOLS === "1";
const TOOL_ALLOWLIST = (process.env.TRIPP_TOOL_ALLOW || "") // e.g. "vision_analyze,search_web"
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const toolValidators = validateToolDefinitions(trippTools);
const allowedTools = trippTools.filter((t) =>
  TOOL_ALLOWLIST.length ? TOOL_ALLOWLIST.includes(t.name) : true
);
const modelFunctions = TOOL_DISABLED
  ? undefined
  : toolsToFunctions(allowedTools); // Responses API "tools" payload

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

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const { client_id, user_id: identityUserId } = await getIdentity(req);
  const clientId = client_id ?? "webchat";

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

    // If an image was attached, append a multimodal user turn and log attachment
    const imageUrl = body?.image_url;
    if (imageUrl) {
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

      // record attachment (best-effort)
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
            tools_enabled: !!modelFunctions,
            persisted: persist,
            memory_scope: identityUserId ? "user" : "session",
          },
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // ---------- TOOL CALLING LOOP ----------
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    const toolsForModel = modelFunctions;

    // first call
    let resp: any;
    try {
      resp = await openai.responses.create({
        model: imageUrl ? "gpt-4o-mini" : "gpt-4.1-mini",
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
        { error: "openai_unavailable", reason: expose ? msg : "model_error" },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    if (toolsForModel) {
      for (let i = 0; i < 2; i++) {
        // collect tool calls from the Responses API structure
        const toolUses: Array<{ id: string; name: string; input: any }> = [];
        for (const out of (resp as any).output ?? []) {
          for (const part of out?.content ?? []) {
            if (part?.type === "tool_use" && part?.name && part?.id) {
              toolUses.push({ id: part.id, name: part.name, input: part.input });
            }
          }
        }
        if (toolUses.length === 0) break;

        // execute tools (with validation) and append tool_result
        for (const tu of toolUses) {
          // validate args against schema
          const inv = validateInvocation(toolValidators, tu.name, tu.input);
          if (!inv.ok) {
            (modelMessages as any[]).push({
              role: "tool",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: tu.id,
                  content: JSON.stringify({
                    error: "invalid_tool_args",
                    detail: inv.errors,
                  }),
                },
              ],
            });
            continue;
          }

          let result: any;
          try {
            const tool = trippTools.find((t) => t.name === tu.name)!;
            result = await tool.execute(tu.input as any, { request: req });
          } catch (e: any) {
            result = { error: String(e?.message || e) };
          }

          (modelMessages as any[]).push({
            role: "tool",
            content: [
              {
                type: "tool_result",
                tool_use_id: tu.id,
                content:
                  typeof result === "string" ? result : JSON.stringify(result),
              },
            ],
          });
        }

        // ask model again with tool results
        try {
          resp = await openai.responses.create({
            model: imageUrl ? "gpt-4o-mini" : "gpt-4.1-mini",
            input: modelMessages as any,
            tools: toolsForModel as any,
            tool_choice: "auto",
          });
        } catch (err: any) {
          const status = err?.status || err?.response?.status;
          const apiMsg =
            err?.error?.message ||
            err?.response?.data?.error?.message ||
            err?.response?.data?.message ||
            err?.message ||
            String(err);

          await auditLog({
            route: "/api/chat:POST",
            status: 502,
            client_id: clientId,
            user_id: identityUserId,
            session_id: sessionId,
            latency_ms: Date.now() - t0,
            error: `openai_error status=${status} msg=${apiMsg}`,
          });

          return NextResponse.json(
            {
              error: "openai_unavailable",
              reason: "model_error",
              detail: apiMsg,
            },
            { status: 502, headers: { "Cache-Control": "no-store" } }
          );
        }
      }
    }
    // ---------- end tool loop ----------

    const assistantText = resp.output_text?.trim() || "Sorry, I came up empty.";

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
          tools_enabled: !!modelFunctions,
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
        headers: { "content-type": "application/json", "Cache-Control": "no-store" },
      }
    );
  }
}
