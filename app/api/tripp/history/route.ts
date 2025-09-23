// app/api/history/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db/db";
import { asc, eq } from "drizzle-orm";
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
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session_id") || "";

  if (!sessionId) {
    return NextResponse.json({ error: "session_id_required" }, { status: 400 });
  }

  const userId = await userIdFromToken(req);

  try {
    // If not logged in or memory disabled, server returns empty transcript.
    // The client should maintain its own rolling window in anon/memory-off mode.
    if (!userId || !(await readPrefs(userId))) {
      await auditLog({
        route: "/api/history:GET",
        status: 200,
        client_id: "webchat",
        user_id: userId,
        session_id: sessionId,
        latency_ms: Date.now() - t0,
      });
      return NextResponse.json([]);
    }

    const rows = await db
      .select({
        role: schema.chatMessages.role,
        content: schema.chatMessages.content,
        created_at: schema.chatMessages.createdAt,
      })
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.sessionId, sessionId))
      .orderBy(asc(schema.chatMessages.createdAt));

    await auditLog({
      route: "/api/history:GET",
      status: 200,
      client_id: "webchat",
      user_id: userId,
      session_id: sessionId,
      latency_ms: Date.now() - t0,
    });

    return NextResponse.json(rows);
  } catch (e: any) {
    await auditLog({
      route: "/api/history:GET",
      status: 500,
      client_id: "webchat",
      user_id: userId,
      session_id: sessionId,
      latency_ms: Date.now() - t0,
      error: String(e?.message || e),
    });
    return NextResponse.json({ error: "history_fetch_failed" }, { status: 500 });
  }
}
