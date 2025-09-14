// app/api/tripp/history/route.ts
import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db/db"; 

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    // accept both sessionId and session_id just in case
    const sessionId =
      searchParams.get("sessionId") ?? searchParams.get("session_id");

    if (!sessionId) {
      return NextResponse.json(
        { error: "missing sessionId" },
        { status: 400, headers: { "content-type": "application/json" } }
      );
    }

    const rows = await db
      .select({
        role: schema.chatMessages.role,
        content: schema.chatMessages.content,
        created_at: schema.chatMessages.createdAt,
      })
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.sessionId, sessionId))
      .orderBy(asc(schema.chatMessages.createdAt));

    return NextResponse.json({ messages: rows }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json(
      { error: "history_failed", detail: String(e) },
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
}
