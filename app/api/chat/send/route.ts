// app/api/chat/send/route.ts (server)
import { NextResponse } from "next/server";
import { db } from "@/app/api/_lib/db/db";
import { chatMessages } from "@/app/api/_lib/db/schema";
import { and, eq } from "drizzle-orm";

export async function POST(req: Request) {
  const { sessionId, text, memoryEnabled, userId } = await req.json();

  // Always allowed to respond, but only persist when opted in
  if (memoryEnabled && text?.trim()) {
    await db.insert(chatMessages).values({
      sessionId,
      role: "user",
      content: text,
      // Optional extras if you added columns:
      // userId,
      // contentLen: text.length,
      // contentSha256: await sha256(text),
      // contentRedacted: false,
    });
  }

  // …call your model, log audit, return assistant message (not shown)
  return NextResponse.json({ ok: true });
}
