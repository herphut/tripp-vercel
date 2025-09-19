import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export async function GET() {
  try {
    const client = neon(process.env.POSTGRES_URL!); // or DATABASE_URL
    const rows = await client`
      select current_database() as db, current_user as usr, version() as v, now() as now
    `;
    return NextResponse.json({ ok: true, rows });
  } catch (e:any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
