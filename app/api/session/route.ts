// app/api/session/route.ts
export const runtime = "nodejs";
import "server-only";

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { db, schema } from "@/app/api/_lib/db/db";
import { auditLog } from "@/app/api/_lib/audit";
import { getIdentity } from "@/app/api/_lib/identity";

/**
 * POST /api/session
 * Creates a brand-new logical chat session id.
 * - Does NOT touch auth cookies (that's /api/auth/exchange's job)
 * - Inserts a chat_sessions row best-effort, but still returns a usable session_id if DB is down.
 */
export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const { client_id, user_id } = await getIdentity(req);
  const clientId = client_id ?? "webchat";
  const sessionId = crypto.randomUUID();

  try {
    // Best effort: create a row so messages/history can attach when memory is ON.
    // (If a row already exists for this sessionId—unlikely—we do nothing.)
    await db
      .insert(schema.chatSessions)
      .values({
        sessionId,
        clientId,
        userId: user_id ?? null,
      })
      .onConflictDoNothing();

    await auditLog({
      route: "/api/session:POST",
      status: 200,
      client_id: clientId,
      user_id,
      session_id: sessionId,
      latency_ms: Date.now() - t0,
    });

    return NextResponse.json(
      { session_id: sessionId },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e: any) {
    // Still return a session id so the UI can proceed; flag the failure.
    await auditLog({
      route: "/api/session:POST",
      status: 200, // respond OK so UX continues
      client_id: clientId,
      user_id,
      session_id: sessionId,
      latency_ms: Date.now() - t0,
      error: `db_create_failed: ${String(e?.message || e)}`,
    });

    return NextResponse.json(
      { session_id: sessionId, warn: "db_create_failed" },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
}

// Optional: reject other methods explicitly (helps with noisy crawlers)
export async function GET() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
