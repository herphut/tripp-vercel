// app/api/preferences/memory/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/src/db/db";
import { userPrefs, chatSessions, auditLogs } from "@/src/db/schema";
import { eq, and, desc, isNull } from "drizzle-orm";

/**
 * Helper: session cookie -> user_id
 */
async function userIdFromSession(sessionId?: string | null) {
  if (!sessionId) return null;
  const row = await db
    .select({ userId: chatSessions.userId })
    .from(chatSessions)
    .where(and(eq(chatSessions.sessionId, sessionId), isNull(chatSessions.revokedAt)))
    .orderBy(desc(chatSessions.createdAt))
    .limit(1);
  const u = row[0]?.userId ?? null;
  return (u && String(u).length > 0) ? String(u) : null;
}

/**
 * GET -> { memoryOptIn: boolean, scope: "user" | "anonymous" }
 * Reads from tripp.user_prefs based on current session's user.
 */
export async function GET(req: NextRequest) {
  const t0 = Date.now();
  try {
    const sessionId = req.cookies.get("HH_SESSION_ID")?.value || null;
    const userId = await userIdFromSession(sessionId);

    if (!userId) {
      // anonymous or no valid session → default false, scope=anonymous
      return NextResponse.json({ memoryOptIn: false, scope: "anonymous" });
    }

    const rows = await db
      .select({ memoryOptIn: userPrefs.memoryOptIn })
      .from(userPrefs)
      .where(eq(userPrefs.userId, userId))
      .limit(1);

    const memoryOptIn = rows[0]?.memoryOptIn ?? false;

    // (optional) audit
    try {
      await db.insert(auditLogs).values({
        route: "/preferences/memory",
        status: 200,
        clientId: null,
        userId,
        sessionId,
        latencyMs: Date.now() - t0,
        error: null,
      });
    } catch {}

    return NextResponse.json({ memoryOptIn, scope: "user" });
  } catch (e: any) {
    try {
      await db.insert(auditLogs).values({
        route: "/preferences/memory",
        status: 500,
        clientId: null,
        userId: null,
        sessionId: null,
        latencyMs: 0,
        error: String(e?.message || e),
      });
    } catch {}
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

/**
 * POST body: { memoryOptIn: boolean }
 * Upserts into tripp.user_prefs for the current user.
 */
export async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    const sessionId = req.cookies.get("HH_SESSION_ID")?.value || null;
    const userId = await userIdFromSession(sessionId);
    if (!userId) {
      return NextResponse.json({ error: "no_active_session" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const memoryOptIn: boolean = !!body?.memoryOptIn;

    const now = new Date();
    // upsert: on conflict(user_id) update ...
    await db
      .insert(userPrefs)
      .values({ userId, memoryOptIn, updatedAt: now })
      .onConflictDoUpdate({
        target: userPrefs.userId,
        set: { memoryOptIn, updatedAt: now },
      });

    // (optional) audit
    try {
      await db.insert(auditLogs).values({
        route: "/preferences/memory",
        status: 200,
        clientId: null,
        userId,
        sessionId,
        latencyMs: Date.now() - t0,
        error: null,
      });
    } catch {}

    return NextResponse.json({ ok: true, memoryOptIn, scope: "user" });
  } catch (e: any) {
    try {
      await db.insert(auditLogs).values({
        route: "/preferences/memory",
        status: 500,
        clientId: null,
        userId: null,
        sessionId: null,
        latencyMs: 0,
        error: String(e?.message || e),
      });
    } catch {}
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
