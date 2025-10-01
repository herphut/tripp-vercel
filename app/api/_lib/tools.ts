// app/api/_lib/agents/tools.ts  (or src/agents/tools.ts if you haven't moved yet)
import "server-only";
import OpenAI from "openai";
import type { NextRequest } from "next/server";
import { put } from "@vercel/blob";

// ----------------------
// Shared Tool Interfaces
// ----------------------
export type ToolContext = { request: NextRequest };

export interface Tool<Args, Result> {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  execute(args: Args, ctx: ToolContext): Promise<Result>;
}

// Keep a single OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// ----------------------
// Small utilities
// ----------------------
function withTimeout<T>(p: Promise<T>, ms = 10000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

// (Optional) super-simple allowlist if you want to restrict where images can be fetched from.
// function isAllowedImageUrl(u: string) {
//   try {
//     const url = new URL(u);
//     const allowed = new Set([
//       "blob.vercel-storage.com",
//       "public.blob.vercel-storage.com",
//       "tripp.herphut.com",
//       "herphut.com",
//     ]);
//     return allowed.has(url.hostname);
//   } catch {
//     return false;
//   }
// }

async function fetchAsBlob(url: string, maxBytes = 8 * 1024 * 1024): Promise<Blob> {
  const r = await withTimeout(fetch(url, { cache: "no-store" }), 12000);
  if (!r.ok) throw new Error(`fetch ${r.status}`);
  const len = Number(r.headers.get("content-length") || 0);
  if (len && len > maxBytes) throw new Error("image too large");
  const ab = await r.arrayBuffer();
  if (ab.byteLength > maxBytes) throw new Error("image too large");
  return new Blob([ab]);
}

// ----------------------
// Web Search (Tavily/Brave)
// ----------------------
export type WebResult = { title: string; url: string; snippet?: string };

async function searchWithTavily(query: string, limit = 5): Promise<WebResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];
  const r = await withTimeout(
    fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: "basic",
        max_results: limit,
        include_answers: false,
        include_images: false,
        include_image_descriptions: false,
      }),
    }),
    12000
  );
  if (!r.ok) return [];
  const j = await r.json();
  const results: any[] = Array.isArray(j?.results) ? j.results : [];
  return results.slice(0, limit).map((x: any) => ({
    title: String(x.title ?? x.url ?? "Result"),
    url: String(x.url ?? ""),
    snippet: String(x.content ?? ""),
  }));
}

async function searchWithBrave(query: string, limit = 5): Promise<WebResult[]> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return [];
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(limit));
  const r = await withTimeout(
    fetch(url.toString(), { headers: { "X-Subscription-Token": key }, cache: "no-store" }),
    12000
  );
  if (!r.ok) return [];
  const j = await r.json();
  const results: any[] = j?.web?.results ?? [];
  return results.slice(0, limit).map((x: any) => ({
    title: String(x.title ?? x.url ?? "Result"),
    url: String(x.url ?? ""),
    snippet: String(x.description ?? ""),
  }));
}

async function webSearch(query: string, limit = 5): Promise<WebResult[]> {
  const provider = (process.env.SEARCH_PROVIDER || "tavily").toLowerCase();
  try {
    if (provider === "brave") return await searchWithBrave(query, limit);
    return await searchWithTavily(query, limit);
  } catch {
    return [];
  }
}

// Exposed tool: search_web
export const searchWebTool: Tool<
  { query: string; limit?: number },
  { results: WebResult[] }
> = {
  name: "search_web",
  description:
    "Search the web for recent, relevant documents. Returns a list of links with titles and snippets.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      limit: { type: "number", minimum: 1, maximum: 10 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute({ query, limit = 5 }) {
    const results = await webSearch(query, limit);
    return { results };
  },
};

// ----------------------
// Vision (analyze image)
// ----------------------
export const visionAnalyzeTool: Tool<
  { imageUrl: string; question?: string },
  { answer: string }
> = {
  name: "vision_analyze",
  description: "Analyze an image at a URL and answer a question about it.",
  input_schema: {
    type: "object",
    properties: {
      imageUrl: { type: "string", minLength: 1 },
      question: { type: "string" },
    },
    required: ["imageUrl"],
    additionalProperties: false,
  },
  async execute({ imageUrl, question }) {
    // if (!isAllowedImageUrl(imageUrl)) return { answer: "Unsupported image host." };
    const prompt =
      (question && question.trim()) ||
      "Describe the image and note anything important.";

    const parts = [
      { type: "input_text", text: prompt },
      { type: "input_image", image_url: imageUrl, detail: "auto" as const },
    ] as const;

    try {
      const resp = await openai.responses.create({
        model: "gpt-4o-mini",
        input: [{ role: "user", content: parts as any }],
      });
      const answer = resp.output_text?.trim() || "No description available.";
      return { answer };
    } catch {
      return { answer: "Sorry — the vision iguana blinked. Try again in a moment." };
    }
  },
};

// ----------------------
// Image (generate → returns public URL)
// ----------------------
export const imageGenerateTool: Tool<
  { prompt: string; size?: "1024x1024" | "512x512" },
  { url?: string }
> = {
  name: "image_generate",
  description:
    "Generate an image from a text prompt. Returns a public URL to a PNG hosted on Vercel Blob.",
  input_schema: {
    type: "object",
    properties: {
      prompt: { type: "string", minLength: 1, description: "Describe the image to generate." },
      size: {
        type: "string",
        enum: ["512x512", "1024x1024"],
        description: "Output image size.",
        default: "1024x1024"
      },
    },



    // 🔧 Responses API (strict tools) requires listing *every key* here
    required: ["prompt", "size"],
    additionalProperties: false,
  },
  async execute({ prompt, size = "1024x1024" }, ctx: { request: NextRequest }) {
    const r = await openai.images.generate({
      model: "gpt-image-1",
      prompt,
      size,
    });
    const b64 = r.data?.[0]?.b64_json;
    if (!b64) return { url: undefined };

    // Convert to Blob and upload to Vercel Blob (public)
    const buf = Buffer.from(b64, "base64");
    const blob = new Blob([buf], { type: "image/png" });

    const uid =
      ctx.request.headers.get("x-hh-user-id") ??
      ctx.request.headers.get("x-user-id") ??
      "user";
    const key = `gen/${uid}/${Date.now()}_image.png`;

    const { url } = await put(key, blob, { access: "public" });
    return { url };
  },
};

// ----------------------
// Image (edit with optional mask)
// ----------------------
export const imageEditTool: Tool<
  { imageUrl: string; prompt: string; maskUrl?: string; size?: "1024x1024" | "512x512" },
  { dataUrl?: string }
> = {
  name: "image_edit",
  description:
    "Edit an image with a text prompt. Optionally provide a transparent PNG mask (white=keep, transparent=edit). Returns a data URL (PNG).",
  input_schema: {
    type: "object",
    properties: {
      imageUrl: { type: "string", minLength: 1 },
      prompt: { type: "string", minLength: 1 },
      maskUrl: { type: "string" },
      size: { type: "string", enum: ["512x512", "1024x1024"] },
    },
    required: ["imageUrl", "prompt"],
    additionalProperties: false,
  },
  async execute({ imageUrl, prompt, maskUrl, size = "1024x1024" }) {
    try {
      // if (!isAllowedImageUrl(imageUrl)) return { dataUrl: undefined };
      // if (maskUrl && !isAllowedImageUrl(maskUrl)) return { dataUrl: undefined };

      const imageBlob = await fetchAsBlob(imageUrl);
      const maskBlob = maskUrl ? await fetchAsBlob(maskUrl) : undefined;

      const r = await openai.images.edit({
        model: "gpt-image-1",
        prompt,
        image: imageBlob as any, // Node 18+ Blob is OK for the SDK
        ...(maskBlob ? { mask: maskBlob as any } : {}),
        size,
      });

      const b64 = r.data?.[0]?.b64_json;
      return { dataUrl: b64 ? `data:image/png;base64,${b64}` : undefined };
    } catch {
      return { dataUrl: undefined };
    }
  },
};

// ---------- Registry ----------
export const trippTools = [
  // You can leave other tools here if you want;
  // but only "image_generate" will be exposed because of TRIPP_TOOL_ALLOW
  imageGenerateTool,
  // searchWebTool,
  // imageEditTool,
  // visionAnalyzeTool, // (usually keep vision as inline multimodal, not a tool)
];