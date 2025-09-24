// app/api/upload/route.ts
import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { db, schema } from "@/db/db";
import { auditLog } from "@/app/api/_lib/audit";
import { getIdentity } from "@/app/api/_lib/identity";

export const runtime = "edge"; // blob works great on edge

function bad(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const { client_id, user_id } = await getIdentity(req);

  try {
    const ct = req.headers.get("content-type") || "";
    if (!ct.includes("multipart/form-data")) {
      await auditLog({
        route: "/api/upload:POST",
        status: 415,
        client_id,
        user_id,
        latency_ms: Date.now() - t0,
        error: "unsupported_media_type",
      });
      return bad(415, "expected multipart/form-data");
    }

    const form = await req.formData();
    const file = form.get("file") as unknown as File | null;
    const sessionId = String(form.get("session_id") || "").trim();

    if (!file || !sessionId) {
      await auditLog({
        route: "/api/upload:POST",
        status: 400,
        client_id,
        user_id,
        latency_ms: Date.now() - t0,
        error: "missing_file_or_session",
      });
      return bad(400, "missing file or session_id");
    }

    // Generate a stable-ish blob name
    const ext = (file.name?.split(".").pop() || "bin").toLowerCase();
    const key = `uploads/${sessionId}/${Date.now()}-${crypto.randomUUID()}.${ext}`;

    // Upload to Vercel Blob
    const putRes = await put(key, file, {
      access: "public", // switch to "private" + signed URLs later if desired
      addRandomSuffix: false,
      contentType: file.type || "application/octet-stream",
    });

    // Record an attachment row in Neon
    const url = putRes.url;
    const mime = file.type || null;
    const sizeBytes = Number((file as any).size ?? 0) || null;

    const [row] = await db
      .insert(schema.attachments)
      .values({
        sessionId,
        userId: user_id ?? null, // null = anon
        kind: "image",
        url,
        mime,
        sizeBytes,
        source: "upload",
      })
      .returning({ id: schema.attachments.id });

    await auditLog({
      route: "/api/upload:POST",
      status: 200,
      client_id,
      user_id,
      session_id: sessionId,
      latency_ms: Date.now() - t0,
    });

    return NextResponse.json({
      id: row?.id,
      url,
      mime,
      sizeBytes,
    });
  } catch (e: any) {
    await auditLog({
      route: "/api/upload:POST",
      status: 500,
      client_id,
      user_id,
      latency_ms: Date.now() - t0,
      error: String(e?.message || e),
    });
    return bad(500, "upload_failed");
  }
}
