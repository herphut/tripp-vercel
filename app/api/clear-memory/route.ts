// app/api/clear-memory/route.ts
import { NextResponse } from "next/server";
import { getIdentity } from "../_lib/persistence";

export async function POST() {
  const { userId } = await getIdentity();
  if (!userId) return NextResponse.json({ ok: false }, { status: 401 });

  // TODO: implement actual deletion via Neon/Drizzle if needed.
  return NextResponse.json({ ok: true });
}

