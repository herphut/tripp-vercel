// app/api/prefs/route.ts
import { NextRequest, NextResponse } from "next/server";
import { verifyJwtRS256 } from "@/app/api/_lib/jwtVerify";
import { readPrefs, writePrefs } from "@/app/api/_lib/prefs";

function unauth() {
  return NextResponse.json(
    { error: "unauthorized" },
    { status: 401, headers: { "Cache-Control": "no-store" } }
  );
}

async function getUserId(req: NextRequest) {
  const tok = req.cookies.get("HH_ID_TOKEN")?.value;
  if (!tok) return null;
  const { payload } = await verifyJwtRS256(tok);
  const uid = String(payload.sub || "");
  return uid || null;
}

export async function GET(req: NextRequest) {
  try {
    const userId = await getUserId(req);
    if (!userId) return unauth();
    const on = await readPrefs(userId);
    return NextResponse.json(
      { memory_opt_in: on },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e: any) {
    return NextResponse.json(
      { error: "prefs_get_error", reason: String(e?.message || e) },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const userId = await getUserId(req);
    if (!userId) return unauth();

    const body = await req.json().catch(() => ({} as any));
    // accept multiple shapes from client, pick first non-undefined
    const incoming =
      body?.memory_opt_in ??
      body?.memoryOptIn ??
      body?.on ??
      body?.value;

    const on = Boolean(incoming); // <-- use 'incoming', not only snake_case
    const saved = await writePrefs(userId, on);

    return NextResponse.json(
      { memory_opt_in: saved },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e: any) {
    return NextResponse.json(
      { error: "prefs_set_error", reason: String(e?.message || e) },
      { status: 500 }
    );
  }
}
