import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/src/db"; // your existing Drizzle instance
import { verifyJwtRS256 } from "@/lib/jwtVerify";
import { chatSessions, auditLogs } from "@/src/db/schema"; // adjust paths/names to your schema
import { eq, and, desc, sql } from "drizzle-orm";

const MAX_SESS = Number(process.env.TRIPP_MAX_SESSIONS_PER_USER || 5);
const TTL_MIN  = Number(process.env.TRIPP_SESSION_TTL_MIN || 1440); // 24h

function subnet24(ip?: string) {
  if (!ip) return "0.0.0";
  const parts = ip.split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0` : ip;
}
function sha256(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    const idToken = req.cookies.get("HH_ID_TOKEN")?.value;
    if (!idToken) {
      return NextResponse.json({ error: "missing_id_token" }, { status: 401 });
    }

    const { header, payload } = await verifyJwtRS256(idToken);
    const userId: string = String(payload.sub || "");
    if (!userId) return NextResponse.json({ error: "sub_missing" }, { status: 401 });

    // Device fingerprint
    const ua = req.headers.get("user-agent") || "";
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0]?.trim() || "";
    const ip24   = subnet24(ip.replace("::ffff:", ""));
    const uaHash = sha256(ua);
    const ipHash = sha256(ip24);
    const deviceHash = sha256(`${uaHash}:${ip24}`);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + TTL_MIN * 60_000);
    let sessionId: string = crypto.randomUUID();

    // Try to reuse existing
    const existing = await db
      .select({ id: chatSessions.id, sessionId: chatSessions.sessionId })
      .from(chatSessions)
      .where(
        and(eq(chatSessions.userId, userId), eq(chatSessions.deviceHash, deviceHash), sql`revoked_at IS NULL`)
      )
      .orderBy(desc(chatSessions.createdAt))
      .limit(1);

    if (existing.length) {
      sessionId = existing[0].sessionId;
      await db
        .update(chatSessions)
        .set({ lastSeen: now, expiresAt, updatedAt: now })
        .where(eq(chatSessions.id, existing[0].id));
    } else {
      await db.insert(chatSessions).values({
        sessionId,
        clientId: null,
        userId,
        tier: (payload.tier as string) || "free",
        createdAt: now,
        expiresAt,
        lastSeen: now,
        deviceHash,
        uaHash,
        ipHash,
        jti: (payload.jti as string) || null,
        kid: header.kid || null,
        iss: (payload.iss as string) || null,
        aud: (payload.aud as string) || null,
      });

      // Cap sessions
      await db.execute(sql`
        WITH active AS (
          SELECT id FROM tripp.chat_sessions
          WHERE user_id = ${userId} AND revoked_at IS NULL
          ORDER BY created_at DESC
        )
        UPDATE tripp.chat_sessions
        SET revoked_at = NOW()
        WHERE id IN (SELECT id FROM active OFFSET ${MAX_SESS})
      `);
    }

    // Set cookie
    const res = NextResponse.json({ session_id: sessionId, user_id: userId, expires_at: expiresAt.toISOString() });
    res.cookies.set("HH_SESSION_ID", sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      domain: ".herphut.com",
      path: "/",
      expires: expiresAt,
    });

    // Audit log
    try {
      await db.insert(auditLogs).values({
        createdAt: new Date(),
        route: "/auth/exchange",
        status: 200,
        clientId: null,
        userId,
        sessionId,
        latencyMs: Date.now() - t0,
        error: null,
      });
    } catch {}

    return res;
  } catch (err: any) {
    try {
      await db.insert(auditLogs).values({
        createdAt: new Date(),
        route: "/auth/exchange",
        status: 401,
        clientId: null,
        userId: null,
        sessionId: null,
        latencyMs: 0,
        error: String(err?.message || err),
      });
    } catch {}

    const refresh = `https://herphut.com/?hh_sso_refresh=1&return=${encodeURIComponent("https://tripp.herphut.com/")}`;
    return NextResponse.json({ error: "jwt_invalid", reason: String(err?.message || err), refresh }, { status: 401 });
  }
}
