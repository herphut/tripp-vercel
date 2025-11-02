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

  const maxAge = 30 * 24 * 60 * 60; // 30 days
  const secureFlag = process.env.NODE_ENV === "production" ? "Secure; " : "";

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

    try {
      await auditLog({
        route: "/api/session:POST",
        status: 200,
        client_id: clientId,
        user_id,
        session_id: sessionId,
        latency_ms: Date.now() - t0,
      });
    } catch (logErr) {
      console.warn("auditLog failed:", logErr);
    }

    // If this is an anonymous session, set an ANON_SESSION_ID cookie so the browser includes it on subsequent requests.
    const cookie = `ANON_SESSION_ID=${sessionId}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; ${secureFlag}`;

    return NextResponse.json(
      { session_id: sessionId },
      { headers: { "Cache-Control": "no-store", "Set-Cookie": cookie } }
    );
  } catch (e: any) {
    // Still return a session id so the UI can proceed; flag the failure.
    try {
      await auditLog({
        route: "/api/session:POST",
        status: 500, // record real failure
        client_id: clientId,
        user_id,
        session_id: sessionId,
        latency_ms: Date.now() - t0,
        error: `db_create_failed: ${String(e?.message || e)}`,
      });
    } catch (logErr) {
      console.warn("auditLog failed:", logErr);
    }

    const cookie = `ANON_SESSION_ID=${sessionId}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; ${secureFlag}`;

    return NextResponse.json(
      { session_id: sessionId, warn: "db_create_failed" },
      { headers: { "Cache-Control": "no-store", "Set-Cookie": cookie } }
    );
  }
}

// Optional: reject other methods explicitly (helps with noisy crawlers)
export async function GET() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}