// app/api/user/status/route.ts
export const runtime = "nodejs";

import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/app/api/_lib/db";
import { chatSessions } from "@/app/api/_lib/db/schema";
import { eq, and, sql } from "drizzle-orm";

// If you already have a helper that returns memory opt-in for a user,
// feel free to use it here. We'll import it softly (optional).
let getMemoryPref: ((userId: string) => Promise<boolean>) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("@/app/api/_lib/session");
  if (typeof mod.getMemoryPref === "function") {
    getMemoryPref = mod.getMemoryPref as (userId: string) => Promise<boolean>;
  }
  // eslint-disable-next-line no-empty
} catch {}

export async function GET(req: NextRequest) {
  try {
    const sid = req.cookies.get("HH_SESSION_ID")?.value || null;
    if (!sid) {
      return NextResponse.json(
        { authenticated: false, userId: null, memoryOptIn: false },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // Find a non-revoked, non-expired session by session_id
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

    // Expired session → treat as guest/unauthenticated
    if (sess.expiresAt && new Date(sess.expiresAt) < now) {
      return NextResponse.json(
        { authenticated: false, userId: null, memoryOptIn: false },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const isAuthed = !!sess.userId;
    if (!isAuthed) {
      // guest session
      return NextResponse.json(
        { authenticated: false, userId: null, memoryOptIn: false },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // Authenticated: fetch memory preference if available
    let memoryOptIn = false;
    if (getMemoryPref) {
      try {
        memoryOptIn = !!(await getMemoryPref(String(sess.userId)));
      } catch {
        memoryOptIn = false;
      }
    }

    return NextResponse.json(
      {
        authenticated: true,
        userId: String(sess.userId),
        memoryOptIn,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    // On any error, default to unauthenticated but keep UI working
    return NextResponse.json(
      { authenticated: false, userId: null, memoryOptIn: false },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
}
