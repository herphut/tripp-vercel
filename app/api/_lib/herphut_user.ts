// app/api/_lib/herphut_user.ts
import { cookies } from "next/headers";
import { jwtVerify, type JWTPayload } from "jose";

export type HerpUser = JWTPayload & {
  sub: string;
  email?: string;
  name?: string;
  roles?: string[];
  tier?: string;
};

const PRIMARY = process.env.APP_SESSION_SECRET;
const LEGACY  = process.env.TRIPP_SIGNING_SECRET;

if (!PRIMARY) {
  console.warn("[HerpHut] APP_SESSION_SECRET is not set. Session verification will fail.");
}

const enc = (s: string) => new TextEncoder().encode(s);

/** Verify with primary secret, then legacy if needed. */
async function verifyWithFallback(jwt: string) {
  if (!PRIMARY) throw new Error("Missing APP_SESSION_SECRET");
  try {
    return await jwtVerify(jwt, enc(PRIMARY));
  } catch (e) {
    if (LEGACY) {
      try {
        return await jwtVerify(jwt, enc(LEGACY));
      } catch {
        // fall through to rethrow original error
      }
    }
    throw e;
  }
}

export async function getCurrentUser(): Promise<HerpUser | null> {
  const token = (await cookies()).get("tripp_session")?.value;
  if (!token) return null;
  try {
    const { payload } = await verifyWithFallback(token);
    if (!payload || typeof payload.sub !== "string") return null;
    return payload as HerpUser;
  } catch {
    return null;
  }
}

export async function getCurrentSessionId(): Promise<string | null> {
  const store = await cookies(); // <- await here
  return store.get("session_id")?.value ?? null;
}

export async function requireUser(): Promise<HerpUser> {
  const u = await getCurrentUser();
  if (!u?.sub) throw new Error("Unauthorized");
  return u;
}

export async function currentUserId(): Promise<string | null> {
  const u = await getCurrentUser();
  return u?.sub ?? null;
}

export async function currentUserEmail(): Promise<string | undefined> {
  const u = await getCurrentUser();
  return u?.email;
}

export async function currentUserTier(): Promise<string | undefined> {
  const u = await getCurrentUser();
  return u?.tier;
}

export function hasRole(user: HerpUser | null, role: string): boolean {
  return !!user?.roles?.includes(role);
}

export function isTierAtLeast(
  user: HerpUser | null,
  order: readonly string[],
  min: string
): boolean {
  if (!user?.tier) return false;
  const i = order.indexOf(user.tier);
  const j = order.indexOf(min);
  return i >= 0 && j >= 0 && i >= j;
}
