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
const TTL_MIN = Number(process.env.TRIPP_SESSION_TTL_MIN || 1440); // 24h
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

function setScopedCookie(
  res: NextResponse,
  name: string,
  value: string,
  ttlMin: number
) {
  const isProd = process.env.NODE_ENV === "production";
  res.cookies.set(name, value, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    domain: isProd ? ".herphut.com" : undefined,
    maxAge: ttlMin * 60,
  });
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();

  if (req.method !== "POST")
    return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });

  const origin = req.headers.get("origin") || "";
  if (origin && !/https:\/\/(?:.+\.)?herphut\.com$/i.test(origin))
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });

  // --- Silent refresh flag (no redirect or downgrade)
  const silent = req.nextUrl.searchParams.get("silent") === "1";

  // --- No-downgrade guard
  const existingSid = req.cookies.get("HH_SESSION_ID")?.value || null;
  let existingUserSessionUserId: string | null = null;
  if (existingSid) {
    try {
      const rows = await db
        .select({
          userId: chatSessions.userId,
          revokedAt: chatSessions.revokedAt,
        })
        .from(chatSessions)
        .where(eq(chatSessions.sessionId, existingSid as any))
        .limit(1);
      const row = rows[0];
      if (row && !row.revokedAt && row.userId)
        existingUserSessionUserId = String(row.userId);
    } catch {}
  }

  let isGuest = false;
  let header: any = null;
  let payload: any = null;
  let idToken =
    req.cookies.get("HH_ID_TOKEN")?.value ??
    getCookieFromHeader(req.headers.get("cookie"), "HH_ID_TOKEN");

  if (existingUserSessionUserId) {
    isGuest = false;
    payload = { sub: existingUserSessionUserId, tier: "free" };
  } else if (!idToken) {
    isGuest = true;
  } else {
    try {
      const v = await verifyJwtRS256(idToken);
      header = v.header;
      payload = v.payload;
      isGuest = false;
    } catch (e: any) {
      const refresh = `https://herphut.com/wp-json/herphut-sso/v1/refresh?return=${encodeURIComponent(
        "https://tripp.herphut.com/"
      )}`;
      if (silent)
        return NextResponse.json({ error: "jwt_invalid" }, { status: 401 });
      return NextResponse.json(
        { error: "jwt_invalid", reason: String(e?.message || e), refresh },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }
  }

  const userId = isGuest ? null : String(payload.sub || "");
  const now = new Date();
  const ttlMin = isGuest ? GUEST_TTL_MIN : TTL_MIN;
  const expiresAt = new Date(now.getTime() + ttlMin * 60_000);
  const tier = isGuest ? "guest" : (payload.tier as string) || "free";
  let sessionId: UUID = crypto.randomUUID() as UUID;

  // --- Device fingerprint
  const ua = req.headers.get("user-agent") || "";
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0]?.trim() || "";
  const ip24 = subnet24(ip.replace("::ffff:", ""));
  const uaHash = sha256(ua);
  const ipHash = sha256(ip24);
  const deviceHash = sha256(`${uaHash}:${ipHash}`);

  try {
    // --- Reuse or upgrade existing session
 // --- Reuse or upgrade existing session (AUTHED) ---
if (!isGuest) {
  const uid = userId as string; // narrow to non-null inside !isGuest

  const existing = await db
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

  if (existing.length) {
    // Reuse: refresh TTL + backfill any missing hashes/JWT fields
    sessionId = existing[0].sessionId as UUID;
    await db
      .update(chatSessions)
      .set({
        clientId: CLIENT_ID.toLowerCase(), // normalize casing
        userId: uid,                       // keep asserted user id
        tier,
        updatedAt: now,
        lastSeen: now,
        expiresAt,
        // backfill only if null in DB (preserve existing non-nulls)
        deviceHash: sql`COALESCE(${chatSessions.deviceHash}, ${deviceHash})`,
        uaHash:     sql`COALESCE(${chatSessions.uaHash}, ${uaHash})`,
        ipHash:     sql`COALESCE(${chatSessions.ipHash}, ${ipHash})`,
        jti:        sql`COALESCE(${chatSessions.jti}, ${payload?.jti ?? null})`,
        kid:        sql`COALESCE(${chatSessions.kid}, ${header?.kid ?? null})`,
        iss:        sql`COALESCE(${chatSessions.iss}, ${payload?.iss ?? null})`,
        aud:        sql`COALESCE(${chatSessions.aud}, ${payload?.aud ?? null})`,
      })
      .where(eq(chatSessions.id, existing[0].id));
  } else {
    // Insert fresh authed row
    await db
      .insert(chatSessions)
      .values({
        sessionId,
        clientId: CLIENT_ID.toLowerCase(),
        userId: uid,
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
        target: chatSessions.sessionId, // UNIQUE(session_id)
        set: {
          clientId: CLIENT_ID.toLowerCase(),
          userId: uid,
          tier,
          updatedAt: now,
          lastSeen: now,
          expiresAt,
          // backfill hashes/JWT if they were null on the existing row
          deviceHash: sql`COALESCE(${chatSessions.deviceHash}, ${deviceHash})`,
          uaHash:     sql`COALESCE(${chatSessions.uaHash}, ${uaHash})`,
          ipHash:     sql`COALESCE(${chatSessions.ipHash}, ${ipHash})`,
          jti:        sql`COALESCE(${chatSessions.jti}, ${payload?.jti ?? null})`,
          kid:        sql`COALESCE(${chatSessions.kid}, ${header?.kid ?? null})`,
          iss:        sql`COALESCE(${chatSessions.iss}, ${payload?.iss ?? null})`,
          aud:        sql`COALESCE(${chatSessions.aud}, ${payload?.aud ?? null})`,
        },
      });
  }
} else {
  
       // --- Guest reuse/insert ---
  const existing = await db
    .select({ id: chatSessions.id, sessionId: chatSessions.sessionId })
    .from(chatSessions)
    .where(and(eq(chatSessions.deviceHash, deviceHash), sql`revoked_at IS NULL`))
    .orderBy(desc(chatSessions.createdAt))
    .limit(1);

  if (existing.length) {
    sessionId = existing[0].sessionId as UUID;
    await db
      .update(chatSessions)
      .set({
        clientId: CLIENT_ID.toLowerCase(),
        userId: null, // ensure guest stays guest here
        tier,
        updatedAt: now,
        lastSeen: now,
        expiresAt,
        deviceHash: sql`COALESCE(${chatSessions.deviceHash}, ${deviceHash})`,
        uaHash:     sql`COALESCE(${chatSessions.uaHash}, ${uaHash})`,
        ipHash:     sql`COALESCE(${chatSessions.ipHash}, ${ipHash})`,
        // leave jti/kid/iss/aud as-is for guests; keep null unless you have guest JWTs
      })
      .where(eq(chatSessions.id, existing[0].id));
  } else {
    await db.insert(chatSessions).values({
      sessionId,
      clientId: CLIENT_ID.toLowerCase(),
      userId: null,
      tier,
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
        clientId: CLIENT_ID.toLowerCase(),
        userId: null,
        tier,
        updatedAt: now,
        lastSeen: now,
        expiresAt,
        deviceHash: sql`COALESCE(${chatSessions.deviceHash}, ${deviceHash})`,
        uaHash:     sql`COALESCE(${chatSessions.uaHash}, ${uaHash})`,
        ipHash:     sql`COALESCE(${chatSessions.ipHash}, ${ipHash})`,
      },
    });
  }
}

    // --- Response + cookies
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

    // Shared cookies
    setScopedCookie(res, "HH_SESSION_ID", sessionId, ttlMin);
    if (!isGuest && idToken) setScopedCookie(res, "HH_ID_TOKEN", idToken, ttlMin);

    // Audit success
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

    return res;
  } catch (e: any) {
    const msg = e?.message || String(e);
    await db.insert(auditLogs).values({
      createdAt: new Date(),
      route: "/auth/exchange",
      status: 500,
      clientId: CLIENT_ID,
      userId,
      sessionId: null,
      latencyMs: Date.now() - t0,
      error: msg,
    });
    return NextResponse.json({ error: "db_error", detail: msg }, { status: 500 });
  }
}
