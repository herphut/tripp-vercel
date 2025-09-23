// src/agents/tools.ts
import OpenAI from "openai";
import type { NextRequest } from "next/server";

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
// Web Search (Tavily/Brave)
// ----------------------

export type WebResult = { title: string; url: string; snippet?: string };

async function searchWithTavily(query: string, limit = 5): Promise<WebResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];
  const r = await fetch("https://api.tavily.com/search", {
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
  });
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
  const r = await fetch(url.toString(), {
    headers: { "X-Subscription-Token": key },
    cache: "no-store",
  });
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
      query: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 10 },
    },
    required: ["query"],
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
      imageUrl: { type: "string" },
      question: { type: "string" },
    },
    required: ["imageUrl"],
  },
  async execute({ imageUrl, question }) {
    const prompt =
      (question && question.trim()) ||
      "Describe the image and note anything important.";

    const parts = [
      { type: "input_text", text: prompt },
      { type: "input_image", image_url: imageUrl, detail: "auto" as const },
    ] as const;

    const resp = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [{ role: "user", content: parts as any }],
    });

    const answer = resp.output_text?.trim() || "No description available.";
    return { answer };
  },
};

// ----------------------
// Image (generate)
// ----------------------
export const imageGenerateTool: Tool<
  { prompt: string; size?: "1024x1024" | "512x512" },
  { dataUrl?: string }
> = {
  name: "image_generate",
  description: "Generate an image from a text prompt. Returns a data URL (PNG).",
  input_schema: {
    type: "object",
    properties: {
      prompt: { type: "string" },
      size: { type: "string", enum: ["512x512", "1024x1024"] },
    },
    required: ["prompt"],
  },
  async execute({ prompt, size = "1024x1024" }) {
    const r = await openai.images.generate({
      model: "gpt-image-1",
      prompt,
      size,
    });
    const b64 = r.data?.[0]?.b64_json;
    return { dataUrl: b64 ? `data:image/png;base64,${b64}` : undefined };
  },
};

// ----------------------
// Image (edit with optional mask)
// ----------------------
async function fetchAsBlob(url: string): Promise<Blob> {
  const r = await fetch(url);
  const ab = await r.arrayBuffer();
  return new Blob([ab]);
}

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
      imageUrl: { type: "string" },
      prompt: { type: "string" },
      maskUrl: { type: "string" },
      size: { type: "string", enum: ["512x512", "1024x1024"] },
    },
    required: ["imageUrl", "prompt"],
  },
  async execute({ imageUrl, prompt, maskUrl, size = "1024x1024" }) {
    const imageBlob = await fetchAsBlob(imageUrl);
    const maskBlob = maskUrl ? await fetchAsBlob(maskUrl) : undefined;

    const r = await openai.images.edit({
      model: "gpt-image-1",
      prompt,
      image: imageBlob as any, // Node 18+ Blob is acceptable to the SDK
      ...(maskBlob ? { mask: maskBlob as any } : {}),
      size,
    });

    const b64 = r.data?.[0]?.b64_json;
    return { dataUrl: b64 ? `data:image/png;base64,${b64}` : undefined };
  },
};

// ----------------------
// Export Registry
// ----------------------
export const trippTools = [
  searchWebTool,
  visionAnalyzeTool,
  imageGenerateTool,
  imageEditTool,
];
