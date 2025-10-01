// app/api/preferences/memory/route.ts
import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";

import { db } from "@/app/api/_lib/db";
import { verifyJwtRS256 } from "@/app/api/_lib/jwtVerify";
import { userPrefs } from "@/app/api/_lib/db/schema"; // expects: userId (text, PK/unique), memoryOptIn (boolean)
import { eq } from "drizzle-orm";

// NOTE: if your Drizzle schema property is named `memoryOptIn` but the DB column
// is `memory_opt_in`, that's normal. Drizzle maps camelCase <-> snake_case.
// This file uses the Drizzle field (likely `userPrefs.memoryOptIn`).

async function userIdFromJwt(req: NextRequest): Promise<string | null> {
  const raw =
    req.cookies.get("HH_ID_TOKEN")?.value ??
    (req.headers.get("cookie") || "")
      .split("; ")
      .find((s) => s.startsWith("HH_ID_TOKEN="))
      ?.split("=")[1];
  if (!raw) return null;
  try {
    const { payload } = await verifyJwtRS256(raw);
    const uid = String(payload.sub || "");
    return uid || null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const uid = await userIdFromJwt(req);
  if (!uid) {
    // Guests see no toggle; client can check authenticated=false
    return NextResponse.json(
      { authenticated: false, memory_opt_in: false },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const row = await db.query.userPrefs.findFirst({ where: eq(userPrefs.userId, uid) });
  const on = !!row?.memoryOptIn; // Drizzle field (maps to DB memory_opt_in)
  return NextResponse.json(
    { authenticated: true, memory_opt_in: on },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest) {
  const uid = await userIdFromJwt(req);
  if (!uid) return NextResponse.json({ error: "login_required" }, { status: 403 });

  const body = await req.json().catch(() => ({} as any));
  // Accept a few shapes for safety, prefer `memory_opt_in`
  const incoming =
    body?.memory_opt_in ??
    body?.memoryOptIn ??
    body?.optIn ??
    body?.on ??
    body?.value;

  const on = Boolean(incoming);

  await db
    .insert(userPrefs)
    .values({
      userId: uid,
      memoryOptIn: on, // Drizzle field (DB column memory_opt_in)
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userPrefs.userId,
      set: { memoryOptIn: on, updatedAt: new Date() },
    });

  return NextResponse.json(
    { authenticated: true, memory_opt_in: on },
    { headers: { "Cache-Control": "no-store" } }
  );
}
