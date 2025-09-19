import { NextResponse } from "next/server";

export async function GET() {
  try {
    const r = await fetch(process.env.TRIPP_JWKS_URL!, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`status_${r.status}`);
    const jwks = await r.json();
    const count = Array.isArray(jwks?.keys) ? jwks.keys.length : 0;
    return NextResponse.json({ ok: true, kidCount: count });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
