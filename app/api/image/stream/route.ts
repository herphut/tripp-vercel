// app/api/image/stream/route.ts
export const runtime = "nodejs";
import "server-only";
import { NextRequest } from "next/server";
import OpenAI from "openai";
import { verifyJwtRS256 } from "@/app/api/_lib/jwtVerify";

// Helper to read cookie from header string if needed
function readCookie(header: string | null, key: string): string | null {
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const [k, v] = part.split("=");
    if (k === key) return decodeURIComponent(v ?? "");
  }
  return null;
}

export async function GET(req: NextRequest) {
  // ---- AUTH: require logged-in user ----
  try {
    const raw =
      req.cookies.get("HH_ID_TOKEN")?.value ??
      readCookie(req.headers.get("cookie"), "HH_ID_TOKEN");
    if (!raw) {
      return new Response("Unauthorized", { status: 401 });
    }
    const { payload } = await verifyJwtRS256(raw);
    const uid = String(payload.sub || "");
    if (!uid) {
      return new Response("Unauthorized", { status: 401 });
    }
    // (Optional) you can add tier checks or rate limits here using uid
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  // ---- Params ----
  const url = new URL(req.url);
  const prompt = url.searchParams.get("prompt") || "A happy iguana waving hello";
  const size = (url.searchParams.get("size") || "1024x1024") as
    | "1024x1024"
    | "1024x1536"
    | "1536x1024";
  const partials = Math.max(1, Math.min(3, Number(url.searchParams.get("partials") || "2")));

  if (!process.env.OPENAI_API_KEY) {
    return new Response("Missing OPENAI_API_KEY", { status: 500 });
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

  // ---- OpenAI stream (image partials) ----
  const stream = await client.responses.stream({
    model: "gpt-image-1",
    input: prompt,
    stream: true,
    tools: [
      {
        type: "image_generation",
        size,
        partial_images: partials, // 1–3 partial frames during generation
      } as any,
    ],
  });

  // ---- SSE wrapper ----
  const encoder = new TextEncoder();

  const rs = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode("retry: 1000\n\n"));

      try {
        for await (const event of stream) {
          controller.enqueue(encoder.encode(`event: ${event.type}\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`
          )
        );
      } finally {
        controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
        controller.close();
      }
    },
  });

  return new Response(rs, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}