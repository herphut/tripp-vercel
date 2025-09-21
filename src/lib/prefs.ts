// src/lib/prefs.ts
import { db } from "@/src/db";
import { userPrefs } from "@/src/db/schema";
import { eq } from "drizzle-orm";

export async function ensurePrefsRow(userId: string) {
  await db.insert(userPrefs)
    .values({ userId, memoryOptIn: false })
    .onConflictDoNothing(); // safe if already there
}

export async function readPrefs(userId: string) {
  await ensurePrefsRow(userId);
  const row = await db.query.userPrefs.findFirst({ where: (t, { eq }) => eq(t.userId, userId) });
  return !!row?.memoryOptIn;
}

export async function writePrefs(userId: string, on: boolean) {
  await ensurePrefsRow(userId);
  await db.update(userPrefs)
    .set({ memoryOptIn: on, updatedAt: new Date() })
    .where(eq(userPrefs.userId, userId));
  return on;
}
