// src/lib/prefs.ts
import { db } from "@/src/db/db";
import { userPrefs } from "@/src/db/schema";
import { eq } from "drizzle-orm";

/**
 * Read-only: return user's current memory opt-in.
 * If no row exists, treat as false (do NOT create a row here).
 */
export async function readPrefs(userId: string): Promise<boolean> {
  if (!userId) return false;
  const r = await db
    .select({ on: userPrefs.memoryOptIn })
    .from(userPrefs)
    .where(eq(userPrefs.userId, userId))
    .limit(1);
  return !!r[0]?.on;
}

/**
 * Single writer: UPSERT the preference.
 * This is the only place that should write to tripp.user_prefs.
 */
export async function writePrefs(userId: string, on: boolean): Promise<boolean> {
  if (!userId) throw new Error("invalid_user_id");
  const now = new Date();
  await db
    .insert(userPrefs)
    .values({ userId, memoryOptIn: on, updatedAt: now })
    .onConflictDoUpdate({
      target: userPrefs.userId,
      set: { memoryOptIn: on, updatedAt: now },
    });
  return on;
}
