// app/api/session/route.ts
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { db, schema } from "@/db/db";
import { desc, eq } from "drizzle-orm";

import { shouldPersist, getIdentity } from "../_lib/persistence";
import { auditLog } from "../_lib/audit";

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const { client_id, user_id } = await getIdentity(req);

  try {
    if (!(await shouldPersist(req))) {
      await auditLog({
        route: "/api/session:POST",
        status: 403,
        client_id,
        user_id,
        latency_ms: Date.now() - t0,
        error: "memory_disabled",
      });
      return NextResponse.json(
        { error: "memory_disabled", detail: "Sign in and opt in to memory to create sessions." },
        { status: 403 }
      );
    }

    const session_id = randomUUID();

    // ✅ Type-safe insert using $inferInsert
    type NewSession = typeof schema.chatSessions.$inferInsert;
    const newRow: NewSession = {
      sessionId: session_id,
      clientId: client_id ?? "anon",
      userId: user_id!,   // you can refine this once auth is wired
      tier: "free",
      // createdAt is usually defaulted by DB; include it here only if your schema requires it
    };

    await db.insert(schema.chatSessions).values(newRow);

    await auditLog({
      route: "/api/session:POST",
      status: 201,
      client_id,
      user_id,
      session_id,
      latency_ms: Date.now() - t0,
    });

    return NextResponse.json({ session_id }, { status: 201 });
  } catch (e: any) {
    await auditLog({
      route: "/api/session:POST",
      status: 500,
      client_id,
      user_id,
      latency_ms: Date.now() - t0,
      error: String(e?.message ?? e),
    });
    return NextResponse.json({ error: "session_create_failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const { client_id, user_id } = await getIdentity(req);

  try {
    if (!(await shouldPersist(req))) {
      await auditLog({
        route: "/api/session:GET",
        status: 200,
        client_id,
        user_id,
        latency_ms: Date.now() - t0,
      });
      return NextResponse.json({ sessions: [] }, { status: 200 });
    }

    // ✅ Simple, type-safe listing (no relations for now)
    const rows = await db
      .select({
        session_id: schema.chatSessions.sessionId,
        created_at: schema.chatSessions.createdAt,
      })
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.userId, user_id!))
      .orderBy(desc(schema.chatSessions.createdAt))
      .limit(20);

    const sessions = rows.map((r) => ({
      session_id: r.session_id,
      created_at: r.created_at,
      title: "New chat", // we can improve later by deriving from first message
    }));

    await auditLog({
      route: "/api/session:GET",
      status: 200,
      client_id,
      user_id,
      latency_ms: Date.now() - t0,
    });

    return NextResponse.json({ sessions }, { status: 200 });
  } catch (e: any) {
    await auditLog({
      route: "/api/session:GET",
      status: 500,
      client_id,
      user_id,
      latency_ms: Date.now() - t0,
      error: String(e?.message ?? e),
    });
    return NextResponse.json({ error: "sessions_list_failed" }, { status: 500 });
  }
}

