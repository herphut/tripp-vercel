// app/api/user/status/route.ts
export const runtime = "nodejs";

import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/app/api/_lib/db";
import { chatSessions, userPrefs } from "@/app/api/_lib/db/schema";
import { eq, and, sql } from "drizzle-orm";

export async function GET(req: NextRequest) {
  try {
    const sid = req.cookies.get("HH_SESSION_ID")?.value || null;
    if (!sid) {
      return NextResponse.json(
        { authenticated: false, userId: null, memoryOptIn: false },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // Look up session (non-revoked)
    const now = new Date();
    const rows = await db
      .select({
        userId: chatSessions.userId,
        expiresAt: chatSessions.expiresAt,
        revokedAt: chatSessions.revokedAt,
        tier: chatSessions.tier,
      })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.sessionId, sid as any),
          sql`(revoked_at IS NULL)`
        )
      )
      .limit(1);

    const sess = rows[0];
    if (!sess) {
      return NextResponse.json(
        { authenticated: false, userId: null, memoryOptIn: false },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // Expired session => guest
    if (sess.expiresAt && new Date(sess.expiresAt) < now) {
      return NextResponse.json(
        { authenticated: false, userId: null, memoryOptIn: false },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const isAuthed = !!sess.userId;
    if (!isAuthed) {
      // Guest session
      return NextResponse.json(
        { authenticated: false, userId: null, memoryOptIn: false },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // Logged-in: read memory pref from Neon via Drizzle
    let memoryOptIn = false;
    try {
      const pref = await db.query.userPrefs.findFirst({
        where: eq(userPrefs.userId, String(sess.userId)),
      });
      memoryOptIn = !!pref?.memoryOptIn; // maps to DB column memory_opt_in
    } catch {
      memoryOptIn = false;
    }

    return NextResponse.json(
      {
        authenticated: true,
        userId: String(sess.userId),
        memoryOptIn,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    // default safe response
    return NextResponse.json(
      { authenticated: false, userId: null, memoryOptIn: false },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
}
