// app/api/prefs/route.ts
import { NextRequest, NextResponse } from "next/server";
import { verifyJwtRS256 } from "@/lib/jwtVerify";
import { readPrefs, writePrefs } from "@/src/lib/prefs";

const noStore = { "Cache-Control": "no-store" };

function unauth() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });
}

function getCookieFromHeader(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

async function getUserId(req: NextRequest) {
  // Primary + fallback (guards against any runtime quirk)
  const tok =
    req.cookies.get("HH_ID_TOKEN")?.value ??
    getCookieFromHeader(req.headers.get("cookie"), "HH_ID_TOKEN");
  if (!tok) return null;
  try {
    const { payload } = await verifyJwtRS256(tok);
    const uid = String(payload.sub || "");
    return uid || null;
  } catch {
    return null;
  }
}

function toBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "on" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "off" || s === "no") return false;
  }
  if (typeof v === "number") return v !== 0;
  return null;
}

export async function GET(req: NextRequest) {
  try {
    const userId = await getUserId(req);
    if (!userId) return unauth();
    const on = await readPrefs(userId); // ensures row exists (defaults false)
    return NextResponse.json({ memory_opt_in: on }, { headers: noStore });
  } catch (e: any) {
    return NextResponse.json(
      { error: "prefs_get_error", reason: String(e?.message || e) },
      { status: 500, headers: noStore }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const userId = await getUserId(req);
    if (!userId) return unauth();

    const body = await req.json().catch(() => ({} as any));
    // Accept several shapes: memory_opt_in, memoryOptIn, on, value
    const incoming =
      body?.memory_opt_in ??
      body?.memoryOptIn ??
      body?.on ??
      body?.value;

    const parsed = toBool(incoming);
    if (parsed === null) {
      return NextResponse.json(
        { error: "bad_request", reason: "expected boolean for memory_opt_in" },
        { status: 400, headers: noStore }
      );
    }

    const saved = await writePrefs(userId, parsed);
    return NextResponse.json({ memory_opt_in: saved }, { headers: noStore });
  } catch (e: any) {
    return NextResponse.json(
      { error: "prefs_set_error", reason: String(e?.message || e) },
      { status: 500, headers: noStore }
    );
  }
}
