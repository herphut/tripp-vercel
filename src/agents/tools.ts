// src/agents/tools.ts
import OpenAI from "openai";
import { neon } from "@neondatabase/serverless";
import type { NextRequest } from "next/server";
import { redactPII } from "@/lib/redact";

const sql = neon(process.env.POSTGRES_URL!);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export type ToolContext = { request: NextRequest };

export interface Tool<Args, Result> {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  execute(args: Args, ctx: ToolContext): Promise<Result>;
}

type Consent = "0" | "1";

// --- helpers ---
function userKeyFromRequest(req: NextRequest): string {
  const c = req.cookies.get("tripp_user")?.value;
  if (c) return c;
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "anon";
  const ua = req.headers.get("user-agent") || "ua";
  return `ip:${ip}|ua:${ua}`;
}
function vectorLiteral(emb: number[]): string {
  return `[${emb.join(",")}]`;
}

// --- tools ---
export const memoryWrite: Tool<{ text: string }, { ok: boolean; error?: string }> = {
  name: "memory_write",
  description: "Store a short, durable memory for this user (PII redacted).",
  input_schema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  async execute({ text }, { request }) {
    if (!text?.trim()) return { ok: false, error: "invalid_text" };

    const consent = request.cookies.get("tripp_mem_consent")?.value as Consent | undefined;
    if (consent !== "1") return { ok: false, error: "no_consent" };

    const safe = redactPII(text);
    const e = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: safe,
    });
    const emb = e.data[0].embedding as number[];
    const userKey = userKeyFromRequest(request);

    await sql`
      INSERT INTO tripp_memory (user_key, text, embedding)
      VALUES (${userKey}, ${safe}, ${vectorLiteral(emb)}::vector)
    `;
    return { ok: true };
  },
};

export const memorySearch: Tool<{ query: string }, { hits: string[] }> = {
  name: "memory_search",
  description: "Retrieve up to 5 user-specific memories relevant to the query.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  async execute({ query }, { request }) {
    if (!query?.trim()) return { hits: [] };

    const q = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });
    const emb = q.data[0].embedding as number[];
    const userKey = userKeyFromRequest(request);

    // No generic on the tag; cast the array result inline
    const rows = (await sql`
      SELECT text
      FROM tripp_memory
      WHERE user_key = ${userKey}
      ORDER BY embedding <-> ${vectorLiteral(emb)}::vector
      LIMIT 5
    `) as Array<{ text: string }>;

    return { hits: rows.map((r) => r.text) };
  },
};

export const trippTools = [memoryWrite, memorySearch];
