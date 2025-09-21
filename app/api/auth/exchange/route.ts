import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";

import crypto from "crypto";
import { db } from "@/src/db";
import { verifyJwtRS256 } from "@/lib/jwtVerify";
import { chatSessions, auditLogs } from "@/src/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";

type UUID = `${string}-${string}-${string}-${string}-${string}`;

const MAX_SESS = Number(process.env.TRIPP_MAX_SESSIONS_PER_USER || 5);
const TTL_MIN  = Number(process.env.TRIPP_SESSION_TTL_MIN || 1440);

function subnet24(ip?: string) {
  if (!ip) return "0.0.0";
  const parts = ip.split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0` : ip;
}
function sha256(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}
function getCookieFromHeader(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    // Primary: Next parser
    let idToken = req.cookies.get("HH_ID_TOKEN")?.value ?? null;

    // Fallback: raw Cookie header (guards against runtime/middleware quirks)
    if (!idToken) {
      idToken = getCookieFromHeader(req.headers.get("cookie"), "HH_ID_TOKEN");
    }

    if (!idToken) {
      return NextResponse.json(
        {
          error: "missing_id_token",
          host: req.headers.get("host") || null,
          has_any_cookie: Boolean(req.headers.get("cookie")),
          note: "Cookie header did not include HH_ID_TOKEN",
        },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Verify JWT (make sure verifyJwtRS256 enforces iss/aud and clockTolerance)
    const { header, payload } = await verifyJwtRS256(idToken);

    const userId = String(payload.sub || "");
    if (!userId) {
      return NextResponse.json(
        { error: "sub_missing" },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Device fingerprint
    const ua = req.headers.get("user-agent") || "";
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0]?.trim() || "";
    const ip24   = subnet24(ip.replace("::ffff:", ""));
    const uaHash = sha256(ua);
    const ipHash = sha256(ip24);
    const deviceHash = sha256(`${uaHash}:${ipHash}`);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + TTL_MIN * 60_000);
    let sessionId: UUID = crypto.randomUUID() as UUID;

    // Reuse if exists
    const existing = await db
      .select({ id: chatSessions.id, sessionId: chatSessions.sessionId })
      .from(chatSessions)
      .where(and(
        eq(chatSessions.userId, userId),
        eq(chatSessions.deviceHash, deviceHash),
        sql`revoked_at IS NULL`
      ))
      .orderBy(desc(chatSessions.createdAt))
      .limit(1);

    if (existing.length) {
      sessionId = existing[0].sessionId as UUID;
      await db.update(chatSessions)
        .set({
          lastSeen: now,
          updatedAt: now,
          expiresAt,
          tier: (payload.tier as string) || "free",
        })
        .where(eq(chatSessions.id, existing[0].id));
    } else {
      try {
  await db.insert(chatSessions)
    .values({
      sessionId,
      clientId: null,
      userId,
      tier: (payload.tier as string) || "free",
      createdAt: now,
      updatedAt: now,
      expiresAt,
      lastSeen: now,
      revokedAt: null,
      deviceHash,
      uaHash,
      ipHash,
      jti: (payload.jti as string) || null,
      kid: header.kid || null,
      iss: (payload.iss as string) || null,
      aud: (payload.aud as string) || null,
    })
    // Use the unique that actually exists in your DB:
    .onConflictDoUpdate({
      target: chatSessions.sessionId, // or [chatSessions.userId, chatSessions.deviceHash]
      set: { updatedAt: now, lastSeen: now, expiresAt, tier: (payload.tier as string) || "free" },
    });
} catch (e: any) {
  const reason = [
    e?.code && `code=${e.code}`,               // 23505 unique_violation, 23502 not_null_violation, etc.
    e?.constraint && `constraint=${e.constraint}`,
    e?.detail && `detail=${e.detail}`,
    e?.message && `message=${e.message}`,
  ].filter(Boolean).join("; ");
  return NextResponse.json(
    { error: "db_error", reason },
    { status: 500, headers: { "Cache-Control": "no-store" } }
  );
}


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
        latencyMs: Date.now() - t0,
        error: String(err?.message || err),
      });
    } catch {}

    const refresh = `https://herphut.com/wp-json/herphut-sso/v1/refresh?return=${encodeURIComponent("https://tripp.herphut.com/")}`;
    return NextResponse.json(
      { error: "jwt_invalid", reason: String(err?.message || err), refresh },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }
}
