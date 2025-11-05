// app/api/sessions/recent/route.ts
export const runtime = "nodejs";
import "server-only";
import { NextRequest, NextResponse } from "next/server";

import { db, schema } from "@/app/api/_lib/db/db";
import { eq, and, isNull, sql } from "drizzle-orm";
import { verifyJwtRS256 } from "@/app/api/_lib/jwtVerify";

const ANON_COOKIE = "ANON_SESSION_ID";

export async function GET(req: NextRequest) {
  try {
    const noStore = { headers: { "Cache-Control": "no-store" } };

    // Grab ID token (cookie or header fallback)
    const raw =
      req.cookies.get("HH_ID_TOKEN")?.value ??
      (req.headers.get("cookie") || "")
        .split("; ")
        .find((s) => s.startsWith("HH_ID_TOKEN="))
        ?.split("=")[1];

    // If not logged in, optionally return the current anon session (UX nicety)
    if (!raw) {
      const anonId = req.cookies.get(ANON_COOKIE)?.value ?? null;
      if (!anonId) return NextResponse.json({ items: [] }, noStore);

      const anonRows = await db
        .select({
          id: schema.chatSessions.sessionId,
          title: schema.chatSessions.title,
          updatedAt: schema.chatSessions.updatedAt,
          lastSeen: schema.chatSessions.lastSeen,
          createdAt: schema.chatSessions.createdAt,
        })
        .from(schema.chatSessions)
        .where(and(eq(schema.chatSessions.sessionId, anonId), isNull(schema.chatSessions.revokedAt)))
        .limit(1);

      const items = anonRows.map((r) => ({
        id: r.id,
        title: r.title ?? "New chat",
        updatedAt: (r.updatedAt ?? r.lastSeen ?? r.createdAt)?.toISOString?.() ?? null,
      }));
      return NextResponse.json({ items }, noStore);
    }

    // Verify and extract user id
    const { payload } = await verifyJwtRS256(raw);
    const uid = String(payload.sub || "");
    if (!uid) return NextResponse.json({ items: [] }, noStore);

    // Recent sessions for this user (ignore revoked)
    const rows = await db
      .select({
        id: schema.chatSessions.sessionId,
        title: schema.chatSessions.title,
        updatedAt: schema.chatSessions.updatedAt,
        lastSeen: schema.chatSessions.lastSeen,
        createdAt: schema.chatSessions.createdAt,
      })
      .from(schema.chatSessions)
      .where(and(eq(schema.chatSessions.userId, uid), isNull(schema.chatSessions.revokedAt)))
      // Drizzle allows raw SQL for complex ordering; GREATEST keeps sidebar lively
      .orderBy(sql`GREATEST(${schema.chatSessions.updatedAt}, ${schema.chatSessions.lastSeen}, ${schema.chatSessions.createdAt}) DESC`)
      .limit(50);

    const items = rows.map((r) => ({
      id: r.id,
      title: r.title ?? "New chat",
      updatedAt: (r.updatedAt ?? r.lastSeen ?? r.createdAt)?.toISOString?.() ?? null,
    }));

    return NextResponse.json({ items }, noStore);
  } catch {
    return NextResponse.json({ items: [] }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }
}

