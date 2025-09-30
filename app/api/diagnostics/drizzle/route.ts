import { NextResponse } from "next/server";
import { db } from "@/app/api/_lib/db/db";         // adjust to your path
import { sql as dsql } from "drizzle-orm";

export async function GET() {
  try {
    // Raw SQL via Drizzle: no schema imports required
    // @ts-ignore drizzle-neon-http allows .execute on a SQL template
    const r = await db.execute(dsql`select 'drizzle-ok' as ok, now() as now`);
    // Some setups don’t expose .execute; then do a no-op like SELECT 1 through the neon client instead.
    // If this throws, tell me and we’ll switch to your supported call.
    // @ts-ignore
    return NextResponse.json({ ok: true, rows: r.rows ?? r });
  } catch (e:any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
