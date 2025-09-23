// app/api/session/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db/db";
import { desc, eq } from "drizzle-orm";
import { verifyJwtRS256 } from "@/lib/jwtVerify";
import { readPrefs } from "@/src/lib/prefs";
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
      return NextResponse.json([]);
    }

    // Pull last 25 sessions for this user
    const rows = await db
      .select({
        id: schema.chatSessions.id,
        sessionId: schema.chatSessions.sessionId,
        created_at: schema.chatSessions.createdAt,
        updated_at: schema.chatSessions.updatedAt,
      })
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.userId, userId))
      .orderBy(desc(schema.chatSessions.createdAt))
      .limit(25);

    // Sidebar expects: { id, title|null, created_at, updated_at }
    const out = rows.map((r) => ({
      id: String(r.sessionId),      // use sessionId as stable identifier for UI selection
      title: null as string | null, // no title column yet
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));

    await auditLog({
      route: "/api/session:GET",
      status: 200,
      client_id: "webchat",
      user_id: userId,
      session_id: null,
      latency_ms: Date.now() - t0,
    });

    return NextResponse.json(out);
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
    return NextResponse.json({ error: "session_list_failed" }, { status: 500 });
  }
}
