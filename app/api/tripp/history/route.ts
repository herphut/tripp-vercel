// app/api/tripp/history/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db/db";
import { eq, asc } from "drizzle-orm";

import { shouldPersist, getIdentity } from "../../_lib/persistence";
import { auditLog } from "../../_lib/audit";

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const { client_id, user_id } = await getIdentity(req);

  try {
    const { searchParams } = new URL(req.url);
    // accept snakeCase or camelCase
    const session_id =
      searchParams.get("session_id") ?? searchParams.get("sessionId");

    if (!session_id) {
      await auditLog({
        route: "/api/tripp/history:GET",
        status: 400,
        client_id,
        user_id,
        latency_ms: Date.now() - t0,
        error: "session_id_required",
      });
      return NextResponse.json({ error: "session_id_required" }, { status: 400 });
    }

    // No memory for anon/opt-out → return empty list (still audited)
    if (!(await shouldPersist(req))) {
      await auditLog({
        route: "/api/tripp/history:GET",
        status: 200,
        client_id,
        user_id,
        session_id,
        latency_ms: Date.now() - t0,
      });
      return NextResponse.json({ messages: [] }, { status: 200 });
    }

    const messages = await db
      .select({
        role: schema.chatMessages.role,
        content: schema.chatMessages.content,
        created_at: schema.chatMessages.createdAt,
      })
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.sessionId, session_id))
      .orderBy(asc(schema.chatMessages.createdAt));

    await auditLog({
      route: "/api/tripp/history:GET",
      status: 200,
      client_id,
      user_id,
      session_id,
      latency_ms: Date.now() - t0,
    });

    return NextResponse.json({ messages }, { status: 200 });
  } catch (e: any) {
    await auditLog({
      route: "/api/tripp/history:GET",
      status: 500,
      client_id,
      user_id,
      latency_ms: Date.now() - t0,
      error: String(e?.message ?? e),
    });
    return NextResponse.json({ error: "history_failed" }, { status: 500 });
  }
}
