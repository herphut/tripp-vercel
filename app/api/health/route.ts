import { NextResponse } from "next/server";
import { db } from "@/app/api/_lib/db/db";
import { sql } from "drizzle-orm";

export async function GET() {
  try {
    const r: any = await db.execute(sql`select now() as now`);
    const now = (Array.isArray(r) ? r[0]?.now : r?.rows?.[0]?.now) ?? null;
    return new Response(JSON.stringify({ ok: true, now }), {
      headers: { "content-type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
