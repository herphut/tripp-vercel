// app/api/auth/exchange/route.ts
import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";

import crypto from "crypto";
import { db } from "@/src/db";
import { verifyJwtRS256 } from "@/lib/jwtVerify";
import { chatSessions, auditLogs } from "@/src/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";

type UUID = `${string}-${string}-${string}-${string}-${string}`;

const MAX_SESS = Number(process.env.TRIPP_MAX_SESSIONS_PER_USER || 5);
const TTL_MIN  = Number(process.env.TRIPP_SESSION_TTL_MIN || 1440); // minutes (default 24h)

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

  // ---- 1) Read ID token from cookies (with raw-header fallback) ----
  let idToken = req.cookies.get("HH_ID_TOKEN")?.value ?? null;
  if (!idToken) idToken = getCookieFromHeader(req.headers.get("cookie"), "HH_ID_TOKEN");

  if (!idToken) {
    return NextResponse.json(
      {
        error: "missing_id_token",
        host: req.headers.get("host") || null,
        has_any_cookie: Boolean(req.headers.get("cookie")),
      },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  // ---- 2) Verify JWT (separate error bucket) ----
  let header: any, payload: any;
  try {
    const v = await verifyJwtRS256(idToken);
    header = v.header;
    payload = v.payload;
  } catch (e: any) {
    try {
      await db.insert(auditLogs).values({
        createdAt: new Date(),
        route: "/auth/exchange",
        status: 401,
        clientId: "Webchat",
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

  const userId = String(payload.sub || "");
  if (!userId) {
    return NextResponse.json(
      { error: "sub_missing" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  // ---- 3) Build device fingerprint ----
  const ua  = req.headers.get("user-agent") || "";
  const ip  = (req.headers.get("x-forwarded-for") || "").split(",")[0]?.trim() || "";
  const ip24 = subnet24(ip.replace("::ffff:", ""));
  const uaHash = sha256(ua);
  const ipHash = sha256(ip24);
  const deviceHash = sha256(`${uaHash}:${ipHash}`);

  // short + explicit, DB requires NOT NULL and <=64 chars
  const clientId = "Webchat";

  const now = new Date();
  const expiresAt = new Date(now.getTime() + TTL_MIN * 60_000);
  let sessionId: UUID = crypto.randomUUID() as UUID;

  try {
    // ---- 4) Try to reuse existing session for this device ----
    const existing = await db
      .select({ id: chatSessions.id, sessionId: chatSessions.sessionId })
      .from(chatSessions)
      .where(and(eq(chatSessions.userId, userId), eq(chatSessions.deviceHash, deviceHash), sql`revoked_at IS NULL`))
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
          tier: (payload.tier as string) || "free",
          clientId, // keep in sync
        })
        .where(eq(chatSessions.id, existing[0].id));
    } else {
      // ---- 5) Insert (UPSERT on UNIQUE(session_id)) ----
      await db
        .insert(chatSessions)
        .values({
          sessionId,
          clientId, // NOT NULL
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
        .onConflictDoUpdate({
          // your schema shows UNIQUE(session_id)
          target: chatSessions.sessionId,
          set: {
            updatedAt: now,
            lastSeen: now,
            expiresAt,
            tier: (payload.tier as string) || "free",
            clientId,
          },
        });

      // ---- 6) Cap sessions per user (keep most recent MAX_SESS) ----
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

    // ---- 7) Set Tripp session cookie ----
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

    // ---- 8) Audit success (best effort) ----
    try {
      await db.insert(auditLogs).values({
        createdAt: new Date(),
        route: "/auth/exchange",
        status: 200,
        clientId,
        userId,
        sessionId,
        latencyMs: Date.now() - t0,
        error: null,
      });
    } catch {}

    return res;
  } catch (e: any) {
    // surface precise PG info so we can diagnose instantly
    const pg = e?.cause ?? e;
    const reason = [
      pg?.code && `code=${pg.code}`,              // 23505 unique_violation, 23502 not_null_violation, 22P02 invalid_text_representation, etc.
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
        clientId,
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
