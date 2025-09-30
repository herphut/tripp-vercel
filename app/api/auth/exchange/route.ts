// app/api/auth/exchange/route.ts
export const runtime = "nodejs";

import "server-only";
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/app/api/_lib/db";
import { verifyJwtRS256 } from "@/app/api/_lib/jwtVerify";
import { chatSessions, auditLogs } from "@/app/api/_lib/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";

type UUID = `${string}-${string}-${string}-${string}-${string}`;

const CLIENT_ID = "webchat";
const MAX_SESS = Number(process.env.TRIPP_MAX_SESSIONS_PER_USER || 5);
// Logged-in users
const TTL_MIN  = Number(process.env.TRIPP_SESSION_TTL_MIN  || 1440); // 24h
// Guests
const GUEST_TTL_MIN = Number(process.env.TRIPP_GUEST_TTL_MIN || 60); // 60m

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
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();

  // (optional) method + origin guard
  if (req.method !== "POST") {
    return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
  }
  const origin = req.headers.get("origin") || "";
  if (origin && !/https:\/\/(?:.+\.)?herphut\.com$/i.test(origin)) {
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  }

  // ---- 1) Read ID token from cookies (with raw-header fallback) ----
  let idToken = req.cookies.get("HH_ID_TOKEN")?.value ?? null;
  if (!idToken) idToken = getCookieFromHeader(req.headers.get("cookie"), "HH_ID_TOKEN");

  // ---- 2) Determine guest vs authed ----
  const isGuest = !idToken;
  let header: any = null, payload: any = null;

  if (!isGuest) {
    // Verify JWT
    try {
      const v = await verifyJwtRS256(idToken!);
      header = v.header;
      payload = v.payload;
    } catch (e: any) {
      try {
        await db.insert(auditLogs).values({
          createdAt: new Date(),
          route: "/auth/exchange",
          status: 401,
          clientId: CLIENT_ID,
          userId: null,
          sessionId: null,
          latencyMs: Date.now() - t0,
          error: String(e?.message || e),
        });
      } catch {}
      const refresh = `https://herphut.com/wp-json/herphut-sso/v1/refresh?return=${encodeURIComponent(
        "https://tripp.herphut.com/"
      )}`;
      return NextResponse.json(
        { error: "jwt_invalid", reason: String(e?.message || e), refresh },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }
  }

  const userId = isGuest ? null : String(payload.sub || "");
  if (!isGuest && !userId) {
    try {
      await db.insert(auditLogs).values({
        createdAt: new Date(),
        route: "/auth/exchange",
        status: 401,
        clientId: CLIENT_ID,
        userId: null,
        sessionId: null,
        latencyMs: Date.now() - t0,
        error: "sub_missing",
      });
    } catch {}
    return NextResponse.json(
      { error: "sub_missing" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  // ---- 3) Device fingerprint (applies to guests too) ----
  const ua  = req.headers.get("user-agent") || "";
  const ip  = (req.headers.get("x-forwarded-for") || "").split(",")[0]?.trim() || "";
  const ip24 = subnet24(ip.replace("::ffff:", ""));
  const uaHash = sha256(ua);
  const ipHash = sha256(ip24);
  const deviceHash = sha256(`${uaHash}:${ipHash}`);

  const now = new Date();
  const ttlMin = isGuest ? GUEST_TTL_MIN : TTL_MIN;
  const expiresAt = new Date(now.getTime() + ttlMin * 60_000);
  const tier = isGuest ? "guest" : (payload.tier as string) || "free";
  let sessionId: UUID = crypto.randomUUID() as UUID;

  try {
    // ---- 4) Reuse latest non-revoked session for this device (user or guest) ----
    const existing = await db
      .select({ id: chatSessions.id, sessionId: chatSessions.sessionId })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.deviceHash, deviceHash),
          sql`revoked_at IS NULL`
        )
      )
      .orderBy(desc(chatSessions.createdAt))
      .limit(1);

    if (existing.length) {
      sessionId = existing[0].sessionId as UUID;
      await db
        .update(chatSessions)
        .set({
          updatedAt: now,
          lastSeen: now,
          expiresAt,
          tier,
          clientId: CLIENT_ID,
          userId: userId ?? null,
        })
        .where(eq(chatSessions.id, existing[0].id));
    } else {
      // ---- 5) Insert new session (UPSERT on UNIQUE(session_id)) ----
      await db
        .insert(chatSessions)
        .values({
          sessionId,
          clientId: CLIENT_ID,
          userId: userId ?? null,
          tier,
          createdAt: now,
          updatedAt: now,
          expiresAt,
          lastSeen: now,
          revokedAt: null,
          deviceHash,
          uaHash,
          ipHash,
          jti: isGuest ? null : (payload.jti as string) || null,
          kid: header?.kid || null,
          iss: isGuest ? null : (payload.iss as string) || null,
          aud: isGuest ? null : (payload.aud as string) || null,
        })
        .onConflictDoUpdate({
          target: chatSessions.sessionId,
          set: {
            updatedAt: now,
            lastSeen: now,
            expiresAt,
            tier,
            clientId: CLIENT_ID,
            userId: userId ?? null,
          },
        });

      // ---- 6) Cap sessions per *user* (guests excluded) ----
      if (userId) {
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
    }

    // ---- 7) Set HH_SESSION_ID cookie (prod vs dev safe) ----
    const host = req.headers.get("host") || "";
    const isProd = process.env.NODE_ENV === "production";
    const prodDomain = /\.herphut\.com$/i.test(host) ? ".herphut.com" : undefined;

    const res = NextResponse.json(
      {
        session_id: sessionId,
        user_id: userId,
        guest: isGuest,
        tier,
        expires_at: expiresAt.toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );

    res.cookies.set("HH_SESSION_ID", sessionId, {
      httpOnly: true,
      secure: isProd,          // true in prod; false locally
      sameSite: "lax",         // same-site between herphut.com and tripp.herphut.com
      domain: prodDomain,      // only in prod; omit on localhost
      path: "/",
      expires: expiresAt,
    });

    // ---- 8) Audit success ----
    try {
      await db.insert(auditLogs).values({
        createdAt: new Date(),
        route: "/auth/exchange",
        status: 200,
        clientId: CLIENT_ID,
        userId,
        sessionId,
        latencyMs: Date.now() - t0,
        error: null,
      });
    } catch {}

    return res;
  } catch (e: any) {
    const pg = e?.cause ?? e;
    const reason = [
      pg?.code && `code=${pg.code}`,
      pg?.constraint && `constraint=${pg.constraint}`,
      pg?.column && `column=${pg.column}`,
      pg?.detail && `detail=${pg.detail}`,
      pg?.message && `message=${pg.message}`,
    ]
      .filter(Boolean)
      .join("; ");

    try {
      await db.insert(auditLogs).values({
        createdAt: new Date(),
        route: "/auth/exchange",
        status: 500,
        clientId: CLIENT_ID,
        userId,
        sessionId,
        latencyMs: Date.now() - t0,
        error: reason || String(e?.message || e),
      });
    } catch {}

    return NextResponse.json(
      { error: "db_error", reason: reason || String(e?.message || e) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
