// app/api/preferences/memory/route.ts
import { NextResponse } from "next/server";
import { db, schema } from "@/db/db";
import { and, eq } from "drizzle-orm";
import { getCurrentUser, getCurrentSessionId } from "@/app/api/_lib/herphut_user";

async function readSessionId(req: Request): Promise<string | null> {
  const fromHeader = req.headers.get("x-session-id");
  if (fromHeader) return fromHeader;
  return await getCurrentSessionId();
}

export async function GET(req: Request) {
  const user = await getCurrentUser();
  const sessionId = await readSessionId(req);

  // If logged-in, prefer user-level truth.
  if (user?.email) {
    const rows = await db
      .select({ memoryOptIn: schema.users.memoryOptIn })
      .from(schema.users)
      .where(eq(schema.users.email, user.email));

    // If no user row yet, fall back to session scope.
    const memoryOptIn =
      rows.length > 0 ? !!rows[0].memoryOptIn : false;

    // snapshot into session if present
    if (sessionId) {
      await db
        .insert(schema.chatSessions)
        .values({ sessionId, clientId: "web", userId: null, memoryOptIn })
        .onConflictDoNothing();
      await db
        .update(schema.chatSessions)
        .set({ memoryOptIn, updatedAt: new Date() })
        .where(eq(schema.chatSessions.sessionId, sessionId));
    }

    return NextResponse.json({ memoryOptIn, scope: "user" });
  }

  // Anon session
  if (sessionId) {
    const rows = await db
      .select({ memoryOptIn: schema.chatSessions.memoryOptIn })
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.sessionId, sessionId));
    return NextResponse.json({ memoryOptIn: !!rows[0]?.memoryOptIn, scope: "session" });
  }

  return NextResponse.json({ memoryOptIn: false, scope: "session" });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const nextValue: boolean = !!body?.memoryOptIn;

  const user = await getCurrentUser();
  const sessionId = await readSessionId(req);

  if (user?.email) {
    // Upsert user row by email with new flag
    const existing = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, user.email));

    if (existing.length === 0) {
      await db.insert(schema.users).values({
        email: user.email,
        memoryOptIn: nextValue,
      });
    } else {
      await db
        .update(schema.users)
        .set({ memoryOptIn: nextValue, updatedAt: new Date() })
        .where(eq(schema.users.email, user.email));
    }

    if (sessionId) {
      await db
        .insert(schema.chatSessions)
        .values({ sessionId, clientId: "web", userId: null, memoryOptIn: nextValue })
        .onConflictDoNothing();
      await db
        .update(schema.chatSessions)
        .set({ memoryOptIn: nextValue, updatedAt: new Date() })
        .where(eq(schema.chatSessions.sessionId, sessionId));
    }

    return NextResponse.json({ ok: true, scope: "user", memoryOptIn: nextValue });
  }

  // Anon session flow
  if (sessionId) {
    await db
      .insert(schema.chatSessions)
      .values({ sessionId, clientId: "anon", userId: null, memoryOptIn: nextValue })
      .onConflictDoNothing();

    await db
      .update(schema.chatSessions)
      .set({ memoryOptIn: nextValue, updatedAt: new Date() })
      .where(eq(schema.chatSessions.sessionId, sessionId));

    return NextResponse.json({ ok: true, scope: "session", memoryOptIn: nextValue });
  }

  return NextResponse.json({ ok: true, scope: "session", memoryOptIn: nextValue });
}
