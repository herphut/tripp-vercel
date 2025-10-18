// app/api/sessions/recent/route.ts
export const runtime = "nodejs";
import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/app/api/_lib/db";
import { chatSessions } from "@/app/api/_lib/db/schema";
import { eq, sql, and } from "drizzle-orm";
import { verifyJwtRS256 } from "@/app/api/_lib/jwtVerify";

export async function GET(req: NextRequest) {
  try {
    const raw = req.cookies.get("HH_ID_TOKEN")?.value ??
      (req.headers.get("cookie") || "").split("; ")
        .find(s => s.startsWith("HH_ID_TOKEN="))?.split("=")[1];

    if (!raw) return NextResponse.json({ items: [] }, { headers: { "Cache-Control": "no-store" } });

    const { payload } = await verifyJwtRS256(raw);
    const uid = String(payload.sub || "");
    if (!uid) return NextResponse.json({ items: [] }, { headers: { "Cache-Control": "no-store" } });

    const rows = await db.select({
      id: chatSessions.sessionId,
      title: chatSessions.title,
      updatedAt: chatSessions.updatedAt,
      lastSeen: chatSessions.lastSeen,
      createdAt: chatSessions.createdAt,
    })
    .from(chatSessions)
    .where(and(
      eq(chatSessions.userId, uid),
      sql`revoked_at IS NULL`
    ))
    .orderBy(sql`GREATEST(updated_at, last_seen, created_at) DESC`)
    .limit(20);

    const items = rows.map(r => ({
      id: r.id,
      title: r.title ?? "New chat",
      updatedAt: (r.updatedAt ?? r.lastSeen ?? r.createdAt)?.toISOString?.() ?? null,
    }));

    return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ items: [] }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }
}
