// app/api/session/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/app/api/_lib/db/db";
import { desc, eq } from "drizzle-orm";
import { verifyJwtRS256 } from "@/app/api/_lib/jwtVerify";
import { readPrefs } from "@/app/api/_lib/prefs";
import { auditLog } from "@/app/api/_lib/audit";

async function userIdFromToken(req: NextRequest): Promise<string | null> {
  const tok =
    req.cookies.get("HH_ID_TOKEN")?.value ||
    (req.headers.get("cookie") || "")
      .split("; ")
      .find((s) => s.startsWith("HH_ID_TOKEN="))
      ?.split("=")[1];
  if (!tok) return null;
  try {
    const { payload } = await verifyJwtRS256(tok);
    const uid = String(payload.sub || "");
    return uid || null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const userId = await userIdFromToken(req);

  try {
    // Anonymous users & memory-off users see no server-side history
    if (!userId || !(await readPrefs(userId))) {
      await auditLog({
        route: "/api/session:GET",
        status: 200,
        client_id: "webchat",
        user_id: userId,
        session_id: null,
        latency_ms: Date.now() - t0,
      });
      return NextResponse.json([], { headers: { "Cache-Control": "no-store" } });
    }

    // Pull last 25 sessions for this user, most recently active first
    const rows = await db
      .select({
        // Use sessionId as the stable identifier for the UI
        id: schema.chatSessions.sessionId,
        title: schema.chatSessions.title,
        created_at: schema.chatSessions.createdAt,
        first_user_at: schema.chatSessions.firstUserAt,
        updated_at: schema.chatSessions.updatedAt,
        last_seen: schema.chatSessions.lastSeen,
      })
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.userId, userId))
      .orderBy(desc(schema.chatSessions.updatedAt))
      .limit(25);

    // Sidebar expects at least: { id, title|null, created_at, updated_at }
    // (We include first_user_at / last_seen too—harmless if the UI ignores them.)
    const out = rows.map((r) => ({
      id: String(r.id),
      title: r.title ?? null,
      created_at: r.created_at,
      first_user_at: r.first_user_at,
      updated_at: r.updated_at,
      last_seen: r.last_seen,
    }));

    await auditLog({
      route: "/api/session:GET",
      status: 200,
      client_id: "webchat",
      user_id: userId,
      session_id: null,
      latency_ms: Date.now() - t0,
    });

    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    await auditLog({
      route: "/api/session:GET",
      status: 500,
      client_id: "webchat",
      user_id: userId,
      session_id: null,
      latency_ms: Date.now() - t0,
      error: String(e?.message || e),
    });
    return NextResponse.json(
      { error: "session_list_failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
