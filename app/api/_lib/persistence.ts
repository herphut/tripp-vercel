// app/api/_lib/persistence.ts
import type { NextRequest } from "next/server";
import {
  getCurrentUser,
  requireUser,
  currentUserId,
  currentUserEmail,
  currentUserTier,
  type HerpUser,
  hasRole,
  isTierAtLeast,
} from "./herphut_user";

export {
  getCurrentUser,
  requireUser,
  currentUserId,
  currentUserEmail,
  currentUserTier,
  type HerpUser,
  hasRole,
  isTierAtLeast,
};

// Old callers sometimes pass req; we ignore it but keep the signature.
export async function shouldPersist(_req?: NextRequest): Promise<boolean> {
  const u = await getCurrentUser();
  return !!u?.sub;
}

/**
 * Back-compat: returns BOTH the new shape and the old fields your routes expect.
 * - userId (new)
 * - email  (new)
 * - client_id (legacy alias = userId)
 * - user_id   (legacy alias = userId)
 */
export async function getIdentity(_req?: NextRequest): Promise<{
  userId: string | null;
  email?: string;
  client_id: string | null;
  user_id: string | null;
}> {
  const u: HerpUser | null = await getCurrentUser();
  const userId = u?.sub ?? null;
  return {
    userId,
    email: u?.email,
    client_id: userId,
    user_id: userId,
  };
}
