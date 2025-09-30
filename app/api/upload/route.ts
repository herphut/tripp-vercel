// app/api/upload/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import crypto from "crypto";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB (adjust as needed)
const ALLOWED_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export async function POST(req: NextRequest) {
  try {
    const contentType = (req.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("multipart/form-data")) {
      return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
    }

    // quick content-length pre-check (optional; may be absent for multipart)
    const contentLength = req.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "missing file field" }, { status: 400 });
    }

    if (!ALLOWED_MIMES.has(file.type)) {
      return NextResponse.json({ error: `unsupported type: ${file.type}` }, { status: 415 });
    }

    if (typeof file.size === "number" && file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "file_too_large", maxBytes: MAX_FILE_BYTES }, { status: 413 });
    }

    const safeName = (file.name || "upload").replace(/[^\w.\-]/g, "_");
    const uid = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString("hex");
    const blobName = `uploads/${Date.now()}_${uid}_${safeName}`;

    // Convert File -> Buffer. Safer for Node SDKs that expect Buffer/stream.
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // If your SDK supports streams, prefer streaming for very large files:
    // const stream = file.stream(); await put(blobName, stream, { access: "public" });

    const { url } = await put(blobName, buffer, { access: "public" });

    return NextResponse.json({ ok: true, url }, { status: 201 });
  } catch (err: any) {
    console.error("upload failed:", err);
    return NextResponse.json(
      { error: "upload_failed", detail: String(err?.message || err) },
      { status: 500 }
    );
  }
}
