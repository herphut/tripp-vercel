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



  // --- NO-DOWNGRADE + AUTH DECISION (replaces old Steps 1 & 2) ---

// If we already have a user session cookie that points to a non-revoked user session,
// don't downgrade to guest even if HH_ID_TOKEN is missing on this request.
const existingSid = req.cookies.get("HH_SESSION_ID")?.value || null;
let existingUserSessionUserId: string | null = null;

if (existingSid) {
  try {
    const rows = await db
      .select({ userId: chatSessions.userId, revokedAt: chatSessions.revokedAt })
      .from(chatSessions)
      .where(eq(chatSessions.sessionId, existingSid as any))
      .limit(1);

    const row = rows[0];
    if (row && !row.revokedAt && row.userId) {
      existingUserSessionUserId = String(row.userId);
    }
  } catch {}
}

let isGuest = false;
let header: any = null;
let payload: any = null;

// Try to read the WordPress SSO token (if present)
let idToken =
  req.cookies.get("HH_ID_TOKEN")?.value ??
  getCookieFromHeader(req.headers.get("cookie"), "HH_ID_TOKEN");

if (existingUserSessionUserId) {
  // Honor the existing authenticated session even if the token is absent this time
  isGuest = false;
  payload = { sub: existingUserSessionUserId, tier: "free" };
} else if (!idToken) {
  // No token and no existing authenticated session → guest
  isGuest = true;
} else {
  // Verify token → authenticated
  try {
    const v = await verifyJwtRS256(idToken);
    header = v.header;
    payload = v.payload;
    isGuest = false;
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
// --- END NO-DOWNGRADE BLOCK ---


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
    // =========================
    // 4) Reuse / Upgrade / Insert (safe, race-tolerant)
    // =========================
    try {
      if (!isGuest) {
        const uid = userId as string; // <-- narrow non-null type for TS
        // 4a) Do we already have an active row for this user+device?
        const existingUser = await db
          .select({ id: chatSessions.id, sessionId: chatSessions.sessionId })
          .from(chatSessions)
          .where(
            and(
              eq(chatSessions.userId, uid),
              eq(chatSessions.deviceHash, deviceHash),
              sql`revoked_at IS NULL`
            )
          )
          .orderBy(desc(chatSessions.createdAt))
          .limit(1);

        if (existingUser.length) {
          sessionId = existingUser[0].sessionId as UUID;
          await db
            .update(chatSessions)
            .set({
              updatedAt: now,
              lastSeen: now,
              expiresAt,
              tier,
              clientId: CLIENT_ID,
            })
            .where(eq(chatSessions.id, existingUser[0].id));
        } else {
          // 4b) No user+device row: claim any active guest row on this device
          const existingGuest = await db
            .select({ id: chatSessions.id, sessionId: chatSessions.sessionId })
            .from(chatSessions)
            .where(
              and(
                sql`user_id IS NULL`,
                eq(chatSessions.deviceHash, deviceHash),
                sql`revoked_at IS NULL`
              )
            )
            .orderBy(desc(chatSessions.createdAt))
            .limit(1);

          if (existingGuest.length) {
            sessionId = existingGuest[0].sessionId as UUID;
            await db
              .update(chatSessions)
              .set({
                userId,                 // upgrade guest → user
                updatedAt: now,
                lastSeen: now,
                expiresAt,
                tier,
                clientId: CLIENT_ID,
              })
              .where(eq(chatSessions.id, existingGuest[0].id));
          } else {
            // 4c) Insert fresh row
            await db
              .insert(chatSessions)
              .values({
                sessionId,
                clientId: CLIENT_ID,
                userId,
                tier,
                createdAt: now,
                updatedAt: now,
                expiresAt,
                lastSeen: now,
                revokedAt: null,
                deviceHash,
                uaHash,
                ipHash,
                jti: (payload?.jti as string) || null,
                kid: header?.kid || null,
                iss: (payload?.iss as string) || null,
                aud: (payload?.aud as string) || null,
              })
              .onConflictDoUpdate({
                // guard UNIQUE(session_id) races
                target: chatSessions.sessionId,
                set: {
                  updatedAt: now,
                  lastSeen: now,
                  expiresAt,
                  tier,
                  clientId: CLIENT_ID,
                  userId,
                },
              });
          }

          // 4d) Cap active sessions per user
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
      } else {
        // Guest path: reuse any active device session (guest or prior), else insert
        const existingAny = await db
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

        if (existingAny.length) {
          sessionId = existingAny[0].sessionId as UUID;
          await db
            .update(chatSessions)
            .set({
              updatedAt: now,
              lastSeen: now,
              expiresAt,
              tier,                // "guest"
              clientId: CLIENT_ID,
              userId: null,
            })
            .where(eq(chatSessions.id, existingAny[0].id));
        } else {
          await db
            .insert(chatSessions)
            .values({
              sessionId,
              clientId: CLIENT_ID,
              userId: null,
              tier,                // "guest"
              createdAt: now,
              updatedAt: now,
              expiresAt,
              lastSeen: now,
              revokedAt: null,
              deviceHash,
              uaHash,
              ipHash,
              jti: null,
              kid: null,
              iss: null,
              aud: null,
            })
            .onConflictDoUpdate({
              target: chatSessions.sessionId,
              set: {
                updatedAt: now,
                lastSeen: now,
                expiresAt,
                tier,
                clientId: CLIENT_ID,
                userId: null,
              },
            });
        }
      }
   } catch (e: any) {
  // Recover from duplicate user_id+device_hash race
  const code = e?.cause?.code || e?.code;
  if (code === "23505") {
    // Narrow inside this block too
    const uid = isGuest ? null : (userId as string);

    const row = await db
      .select({ id: chatSessions.id, sessionId: chatSessions.sessionId })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.deviceHash, deviceHash),
          sql`revoked_at IS NULL`,
          // Only apply the user filter when not a guest
          isGuest ? sql`TRUE` : eq(chatSessions.userId, uid as string)
        )
      )
      .orderBy(desc(chatSessions.createdAt))
      .limit(1);

    if (row.length) {
      sessionId = row[0].sessionId as UUID;
      await db
        .update(chatSessions)
        .set({
          updatedAt: now,
          lastSeen: now,
          expiresAt,
          tier,
          clientId: CLIENT_ID,
          userId: isGuest ? null : (uid as string),
        })
        .where(eq(chatSessions.id, row[0].id));
    } else {
      throw e; // bubble if truly unrecoverable
    }
  } else {
    throw e;
  }
}

    // =========================
    // end Section 4
    // =========================

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
