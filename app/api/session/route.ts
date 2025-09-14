// app/api/session/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db/db";
import { randomUUID } from "crypto";   // ✅ built-in, no npm install
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    let user_id: string | null = null;
    let client_id = req.headers.get("x-client-id") ?? "web-widget-v1";

    try {
      const body = await req.json();
      if (typeof body?.user_id === "string" && body.user_id.trim()) {
        user_id = body.user_id.trim();
      }
      if (typeof body?.client_id === "string" && body.client_id.trim()) {
        client_id = body.client_id.trim();
      }
    } catch { /* no/invalid JSON is fine */ }

    const session_id = randomUUID();   // ✅ replace uuid.v4()

    await db.insert(schema.chatSessions).values({
      sessionId: session_id,
      clientId: client_id,
      userId: user_id,
      tier: "free",
    });

    return NextResponse.json({ session_id }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json(
      { error: "session_create_failed", detail: String(e) },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, route: "session" });
}
