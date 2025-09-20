import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs"; // ensure Node for 'crypto'

import crypto from "crypto";
import { db } from "@/src/db";
import { verifyJwtRS256 } from "@/lib/jwtVerify";
import { chatSessions, auditLogs } from "@/src/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";

type UUID = `${string}-${string}-${string}-${string}-${string}`;

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
      return NextResponse.json(
        { error: "missing_id_token" },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Ensure verifyJwtRS256 enforces iss="https://herphut.com", aud="tripp", clockTolerance ~60s
    const { header, payload } = await verifyJwtRS256(idToken);

    const userId = String(payload.sub || "");
    if (!userId) {
      return NextResponse.json(
        { error: "sub_missing" },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Device fingerprint (UA + /24 IP)
    const ua = req.headers.get("user-agent") || "";
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0]?.trim() || "";
    const ip24   = subnet24(ip.replace("::ffff:", ""));
    const uaHash = sha256(ua);
    const ipHash = sha256(ip24);
    const deviceHash = sha256(`${uaHash}:${ipHash}`);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + TTL_MIN * 60_000);

    // Generate a new session id (assert to UUID type)
    let sessionId: UUID = crypto.randomUUID() as UUID;

    // Try to reuse existing
    const existing = await db
      .select({ id: chatSessions.id, sessionId: chatSessions.sessionId })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.userId, userId),
          eq(chatSessions.deviceHash, deviceHash),
          sql`revoked_at IS NULL`
        )
      )
      .orderBy(desc(chatSessions.createdAt))
      .limit(1);

    if (existing.length) {
      sessionId = existing[0].sessionId as UUID; // keep TS happy
      await db
        .update(chatSessions)
        .set({
          lastSeen: now,
          expiresAt,
          updatedAt: now,
          tier: (payload.tier as string) || "free", // sync tier on reuse
        })
        .where(eq(chatSessions.id, existing[0].id));
    } else {
      await db.insert(chatSessions).values({
        sessionId: sessionId as UUID,
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

      // Cap sessions (confirm schema/table name)
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

    // Set our session cookie + return
    const res = NextResponse.json(
      { session_id: sessionId, user_id: userId, expires_at: expiresAt.toISOString() },
      { headers: { "Cache-Control": "no-store" } }
    );
    res.cookies.set("HH_SESSION_ID", sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      domain: ".herphut.com",
      path: "/",
      expires: expiresAt,
    });

    // Audit log (best-effort)
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
    // Audit the failure (best-effort)
    try {
      await db.insert(auditLogs).values({
        createdAt: new Date(),
        route: "/auth/exchange",
        status: 401,
        clientId: null,
        userId: null,
        sessionId: null,
        latencyMs: Date.now() - t0,
        error: String(err?.message || err),
      });
    } catch {}

    const refresh = `https://herphut.com/sso/refresh?return=${encodeURIComponent("https://tripp.herphut.com/")}`;
    return NextResponse.json(
      { error: "jwt_invalid", reason: String(err?.message || err), refresh },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }
}
