// app/api/session/route.ts
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

type SessionRow = { id: string; title: string | null; created_at: string; updated_at: string | null };
type MessageRow = { role: "user" | "assistant" | "system"; content: string };

export async function POST() {
  const r = await sql<Pick<SessionRow, "id">>`
    INSERT INTO chat_sessions DEFAULT VALUES RETURNING id
  `;
  return NextResponse.json({ id: r.rows[0].id });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const list = searchParams.get("list");
  const id = searchParams.get("id");

  if (list) {
    const r = await sql<SessionRow>`
      SELECT id, title, created_at, updated_at
      FROM chat_sessions
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT 20
    `;
    return NextResponse.json({ sessions: r.rows });
  }

  if (id) {
    const r = await sql<MessageRow>`
      SELECT role, content
      FROM chat_messages
      WHERE session_id = ${id}
      ORDER BY created_at ASC
    `;
    return NextResponse.json({ messages: r.rows });
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
}
