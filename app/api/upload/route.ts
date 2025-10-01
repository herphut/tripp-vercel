// app/api/upload/route.ts
import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { verifyJwtRS256 } from "@/app/api/_lib/jwtVerify";
export const runtime = "nodejs";

function getCookieFromHeader(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    // Require logged-in user
    let idToken = req.cookies.get("HH_ID_TOKEN")?.value ?? null;
    if (!idToken) idToken = getCookieFromHeader(req.headers.get("cookie"), "HH_ID_TOKEN");
    if (!idToken) {
      return NextResponse.json({ error: "forbidden", reason: "login_required" }, { status: 403 });
    }

    // Verify JWT (throws on invalid/expired)
    const { payload } = await verifyJwtRS256(idToken);
    const userId = String(payload.sub || "");
    if (!userId) {
      return NextResponse.json({ error: "forbidden", reason: "invalid_user" }, { status: 403 });
    }

    // Content-type & file
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.startsWith("multipart/form-data")) {
      return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "missing file field" }, { status: 400 });
    }

    const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif"];
    if (!allowed.includes(file.type)) {
      return NextResponse.json({ error: `unsupported type: ${file.type}` }, { status: 415 });
    }

    const maxMB = Number(process.env.TRIPP_UPLOAD_MAX_MB || 8);
    if (file.size > maxMB * 1024 * 1024) {
      return NextResponse.json({ error: "too_large", maxMB }, { status: 413 });
    }

    const blobName = `uploads/${userId}/${Date.now()}_${file.name.replace(/[^\w.\-]/g, "_")}`;
    const { url } = await put(blobName, file, { access: "public" });

    return NextResponse.json({ ok: true, url });
  } catch (e: any) {
    return NextResponse.json({ error: "upload_failed", detail: String(e?.message || e) }, { status: 500 });
  }
}
