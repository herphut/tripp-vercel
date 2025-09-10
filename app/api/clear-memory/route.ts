import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export async function POST(req: NextRequest) {
  const userKey = req.cookies.get("tripp_user")?.value; // ← use req.cookies
  if (!userKey) return NextResponse.json({ ok: true });

  await sql`DELETE FROM chat_sessions WHERE user_key = ${userKey}`;
  await sql`DELETE FROM memories WHERE user_key = ${userKey}`;

  const res = NextResponse.json({ ok: true });
  res.cookies.set("tripp_user", "", { maxAge: 0, path: "/" }); // clear cookie
  return res;
}
