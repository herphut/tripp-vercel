import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { randomUUID } from "crypto";

export async function GET(req: NextRequest) {
  const userKey = req.cookies.get("tripp_user")?.value; // ← use req.cookies
  if (!userKey) return NextResponse.json([]);

  const { rows } = await sql`
    SELECT id, title, updated_at
    FROM chat_sessions
    WHERE user_key = ${userKey}
    ORDER BY updated_at DESC
    LIMIT 10
  `;
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  let userKey = req.cookies.get("tripp_user")?.value;
  if (!userKey) userKey = randomUUID();

  const { title } = await req.json();

  const { rows } = await sql`
    INSERT INTO chat_sessions (user_key, title)
    VALUES (${userKey}, ${title || "New chat"})
    RETURNING id, title, created_at
  `;

  // set cookie on the response
  const res = NextResponse.json(rows[0], { status: 201 });
  res.cookies.set("tripp_user", userKey, {
    httpOnly: true,
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  return res;
}
