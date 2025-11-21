// app/api/user/status/route.ts
export const runtime = "nodejs";

import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/app/api/_lib/db";
import { userPrefs } from "@/app/api/_lib/db/schema";
import { eq } from "drizzle-orm";
import { getIdentity } from "@/app/api/_lib/identity";

export async function GET(req: NextRequest) {
  try {
    // Use JWT-based identity instead of HH_SESSION_ID
    const { user_id } = await getIdentity(req);

    if (!user_id) {
      return NextResponse.json(
        { authenticated: false, userId: null, memoryOptIn: false },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const prefs = await db
      .select({
        memoryOptIn: userPrefs.memoryOptIn,
      })
      .from(userPrefs)
      .where(eq(userPrefs.userId, user_id))
      .limit(1);

    const memoryOptIn = !!prefs[0]?.memoryOptIn;

    return NextResponse.json(
      {
        authenticated: true,
        userId: user_id,
        memoryOptIn,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    // default safe response
    return NextResponse.json(
      { authenticated: false, userId: null, memoryOptIn: false },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
}
