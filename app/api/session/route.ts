// app/api/session/route.ts
import "server-only";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

import { db, schema } from "@/app/api/_lib/db/db";
import { eq, and, ne, desc, gt, isNull } from "drizzle-orm";

import { auditLog } from "@/app/api/_lib/audit";
import { getIdentity } from "@/app/api/_lib/identity";

const ANON_COOKIE = "ANON_SESSION_ID";
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 365; // 1 year

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const isSecure = url.protocol === "https:";

  // Read anon cookie (if any)
  const cookieHeader = req.headers.get("cookie") ?? "";
  const anonCookie = readCookie(cookieHeader, ANON_COOKIE);

  // Identity (safe, no downgrade)
  const ident = await safeGetIdentity(req);
  const userId = ident.mode === "user" ? ident.user_id : null;

  // Basic device fingerprint for audit only
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    null;

  const ua = req.headers.get("user-agent") ?? null;

  const deviceHash =
    ip && ua
      ? crypto.createHash("sha256").update(ip + "|" + ua).digest("hex")
          .slice(0, 32)
      : null;

  // Parse body for idempotency
  const body = await safeJson(req);
  const idempotencyKey: string | null = body?.idempotencyKey ?? null;

  try {
    // 1) If logged-in user + anon cookie present → PROMOTE guest to user
    if (ident.mode === "user" && anonCookie) {
      const promoted = await promoteGuestSession({
        userId,
        guestSessionId: anonCookie,
      });

      if (promoted) {
        await safeAudit({
          event: "session.promote",
          data: { userId, sessionId: promoted, deviceHash, ip, ua },
        });
        return ok({
          sessionId: promoted,
          isSecure,
          setAnonCookie: false, // never set anon cookie for real users
        });
      }
      // If promotion couldn't happen (cookie stale/missing), fall through to create/reuse
    }

    // 2) If idempotencyKey provided, try to reuse
    if (idempotencyKey) {
      const reused = await reuseByIdempotency(idempotencyKey);
      if (reused) {
        await safeAudit({
          event: "session.reuse",
          data: {
            userId,
            sessionId: reused,
            idempotencyKey,
            deviceHash,
            ip,
            ua,
          },
        });
        return ok({
          sessionId: reused,
          isSecure,
          // only anon users get anon cookies
          setAnonCookie: ident.mode === "anon",
        });
      }
    }

    // 3) Create a new session (anon or user) idempotently
    const newSessionId: string = crypto.randomUUID();

    let createdSessionId: string = newSessionId;
    try {
      const inserted = await db
        .insert(schema.chatSessions)
        .values({
          sessionId: newSessionId,
          userId: userId ?? null,
          deviceHash: deviceHash ?? null,
          idempotencyKey: idempotencyKey ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning({ sessionId: schema.chatSessions.sessionId });

      createdSessionId = inserted[0].sessionId;
    } catch (e: any) {
      // If collide on idempotency unique index, re-select
      if (
        idempotencyKey &&
        String(e?.message || "").toLowerCase().includes("duplicate key")
      ) {
        const reused = await reuseByIdempotency(idempotencyKey);
        if (reused) createdSessionId = reused;
        else throw e;
      } else {
        throw e;
      }
    }

    await safeAudit({
      event: "session.create",
      data: {
        userId,
        sessionId: createdSessionId,
        idempotencyKey,
        deviceHash,
        ip,
        ua,
        latency_ms: Date.now() - t0,
      },
    });

    return ok({
      sessionId: createdSessionId,
      isSecure,
      // only true anon gets anon cookie
      setAnonCookie: ident.mode === "anon",
    });
  } catch (e: any) {
    // Non-fatal fallback: return a synthetic session id so client UI can proceed
    const fallback = crypto.randomUUID();
    await safeAudit({
      event: "session.create_fallback",
      data: {
        userId,
        sessionId: fallback,
        deviceHash,
        ip,
        ua,
        error: String(e?.message || e),
        latency_ms: Date.now() - t0,
      },
    });
    return ok({
      sessionId: fallback,
      isSecure,
      setAnonCookie: ident.mode === "anon",
      warn: "db_create_failed",
    });
  }
}

/* ---------------- helpers ---------------- */

function ok(opts: {
  sessionId: string;
  isSecure: boolean;
  setAnonCookie: boolean;
  warn?: string;
}) {
  const { sessionId, isSecure, setAnonCookie, warn } = opts;
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (setAnonCookie) {
    headers["Set-Cookie"] = cookieStr(
      ANON_COOKIE,
      sessionId,
      COOKIE_MAX_AGE_SEC,
      isSecure,
    );
  }
  const payload = warn
    ? { session_id: sessionId, warn }
    : { session_id: sessionId };
  return NextResponse.json(payload, { headers });
}

function cookieStr(
  name: string,
  value: string,
  maxAge: number,
  isSecure: boolean,
) {
  return `${name}=${encodeURIComponent(
    value,
  )}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax;${
    isSecure ? " Secure;" : ""
  }`;
}

function readCookie(header: string, key: string) {
  const parts = header.split(/;\s*/);
  for (const p of parts) {
    const [k, v] = p.split("=");
    if (k === key) return decodeURIComponent(v ?? "");
  }
  return null;
}

async function safeJson(req: NextRequest) {
  try {
    if (!req.body) return null;
    return await req.json();
  } catch {
    return null;
  }
}

async function safeGetIdentity(req: NextRequest) {
  try {
    return await getIdentity(req);
  } catch {
    return {
      user_id: null,
      client_id: "webchat",
      session_id: null,
      anon: false,
      mode: "unknown" as const,
    };
  }
}

/**
 * Accepts EITHER:
 *   safeAudit("event", { ...data })
 * OR
 *   safeAudit({ event: "event", data: { ... } })
 * and normalizes to auditLog({ event, data }).
 */
async function safeAudit(arg1: any, arg2?: any) {
  try {
    const payload =
      typeof arg1 === "string" ? { event: arg1, data: arg2 } : arg1;
    await auditLog(payload);
  } catch {
    // ignore audit failures
  }
}

/* ---- idempotency reuse ---- */
async function reuseByIdempotency(
  idempotencyKey: string,
): Promise<string | null> {
  const rows = await db
    .select({ sessionId: schema.chatSessions.sessionId })
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.idempotencyKey, idempotencyKey))
    .limit(1);
  return rows[0]?.sessionId ?? null;
}

/* ---- promotion + stray-merge ---- */
async function promoteGuestSession({
  userId,
  guestSessionId,
}: {
  userId: string | null;
  guestSessionId: string;
}) {
  if (!userId) return null;

  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);

  return await db.transaction(async (tx) => {
    // 1) Promote the guest session if it exists and is unowned
    const promoted = await tx
      .update(schema.chatSessions)
      .set({ userId, updatedAt: new Date() })
      .where(
        and(
          eq(schema.chatSessions.sessionId, guestSessionId),
          isNull(schema.chatSessions.userId),
        ),
      )
      .returning({ sessionId: schema.chatSessions.sessionId });

    const promotedId = promoted[0]?.sessionId;

    // If nothing promoted, try to reuse latest owned session
    if (!promotedId) {
      const latest = await tx
        .select({ sessionId: schema.chatSessions.sessionId })
        .from(schema.chatSessions)
        .where(eq(schema.chatSessions.userId, userId))
        .orderBy(desc(schema.chatSessions.updatedAt))
        .limit(1);

      return latest[0]?.sessionId ?? null;
    }

    // 2) Merge a stray session created within 15 minutes (best-effort)
    const stray = await tx
      .select({ sessionId: schema.chatSessions.sessionId })
      .from(schema.chatSessions)
      .where(
        and(
          eq(schema.chatSessions.userId, userId),
          ne(schema.chatSessions.sessionId, guestSessionId),
          gt(schema.chatSessions.createdAt, fifteenMinutesAgo),
        ),
      )
      .orderBy(desc(schema.chatSessions.createdAt))
      .limit(1);

    const strayId = stray[0]?.sessionId;
    if (strayId) {
      try {
        // Move messages from stray to promoted
        await tx
          .update(schema.chatMessages)
          .set({ sessionId: guestSessionId })
          .where(eq(schema.chatMessages.sessionId, strayId));

        // Delete stray session row
        await tx
          .delete(schema.chatSessions)
          .where(eq(schema.chatSessions.sessionId, strayId));
      } catch {
        // best-effort only
      }
    }

    // 3) Touch updatedAt for sidebar sorting
    await tx
      .update(schema.chatSessions)
      .set({ updatedAt: new Date() })
      .where(eq(schema.chatSessions.sessionId, guestSessionId));

    return promotedId;
  });
}