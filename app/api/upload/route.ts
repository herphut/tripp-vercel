// app/api/upload/route.ts
import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";

export const runtime = "edge"; // stays on Edge

export async function POST(req: NextRequest) {
  try {
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

    const blobName = `uploads/${Date.now()}_${file.name.replace(/[^\w.\-]/g, "_")}`;
    const { url } = await put(blobName, file, { access: "public" });

    return NextResponse.json({ ok: true, url });
  } catch (e: any) {
    return NextResponse.json({ error: "upload_failed", detail: String(e?.message || e) }, { status: 500 });
  }
}
