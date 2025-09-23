// app/api/upload/route.ts
import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs"; // Blob SDK needs Node runtime
import { put, del } from "@vercel/blob";
import { randomUUID } from "crypto";

const MAX_MB = Number(process.env.UPLOAD_MAX_MB || 8); // tweak as you like

function bad(msg: string, code = 400) {
  return NextResponse.json({ error: msg }, { status: code });
}

export async function POST(req: NextRequest) {
  // Expect multipart/form-data with field "file"
  const form = await req.formData().catch(() => null);
  const file = form?.get("file") as File | null;
  if (!file) return bad("No file");

  // Basic validation
  const bytes = file.size;
  const mb = bytes / (1024 * 1024);
  if (mb > MAX_MB) return bad(`File too large (>${MAX_MB}MB)`);

  const okMime = /^image\/(png|jpeg|jpg|webp|gif|bmp|tiff|svg\+xml)$/i.test(file.type);
  if (!okMime) return bad(`Unsupported type: ${file.type || "unknown"}`);

  // Build a clean, unique key
  const origName = (file.name || "upload").toLowerCase();
  const ext = (origName.match(/\.[a-z0-9+]+$/i)?.[0] || "").replace(/[^a-z0-9.+]/gi, "");
  const key = `uploads/${new Date().toISOString().slice(0,10)}/${randomUUID()}${ext || ".bin"}`;

  // Upload to Vercel Blob
  const { url, pathname, contentType, downloadUrl } = await put(key, file, {
    access: "public",
    token: process.env.BLOB_READ_WRITE_TOKEN!,
    contentType: file.type || undefined,
    addRandomSuffix: false,
    cacheControlMaxAge: 60 * 60 * 24 * 365, // 1 year
  });

  return NextResponse.json({
    ok: true,
    url,            // public https URL for model/tools
    downloadUrl,    // direct download URL (handy for “Save image” buttons)
    key: pathname,  // blob key if you want to delete later
    size: bytes,
    contentType,
  });
}

// Optional: allow DELETE ?url=<blob public URL> (or key) to remove uploads
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get("url");
  const key = searchParams.get("key");
  if (!url && !key) return bad("Missing url or key");
  const target = url ?? key!;
  await del(target, { token: process.env.BLOB_READ_WRITE_TOKEN! });
  return NextResponse.json({ ok: true });
}
