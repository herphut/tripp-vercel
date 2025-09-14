// src/agents/tools.ts
import OpenAI from "openai";
import { sql } from "@vercel/postgres";
import type { NextRequest } from "next/server";
import { redactPII } from "@/lib/redact";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export type ToolContext = { request: NextRequest };

export interface Tool<Args, Result> {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  execute(args: Args, ctx: ToolContext): Promise<Result>;
}

type MemoryRow = { text: string };
type Consent = "0" | "1";

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

/** ---- memory_write ---- */
export const memoryWrite: Tool<{ text: string }, { ok: boolean; error?: string }> = {
  name: "memory_write",
  description: "Store a short, durable memory for this user (PII redacted).",
  input_schema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  async execute({ text }, { request }) {
    if (!text) return { ok: false, error: "invalid_text" };

    const consent: Consent | undefined = request.cookies.get("tripp_mem_consent")?.value as Consent | undefined;
    if (consent !== "1") return { ok: false, error: "no_consent" };

    const safe = await redactPII(text);
    const e = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: safe,
    });
    const emb = e.data[0].embedding as number[];
    const userKey = userKeyFromRequest(request);

    await sql`
      INSERT INTO memories (user_key, text, embedding)
      VALUES (${userKey}, ${safe}, ${vectorLiteral(emb)}::vector)
    `;
    return { ok: true };
  },
};

/** ---- memory_search ---- */
export const memorySearch: Tool<{ query: string }, { hits: string[] }> = {
  name: "memory_search",
  description: "Retrieve up to 5 user-specific memories relevant to the query.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  async execute({ query }, { request }) {
    if (!query) return { hits: [] };

    const q = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });
    const emb = q.data[0].embedding as number[];
    const userKey = userKeyFromRequest(request);

    const res = await sql<MemoryRow>`
      SELECT text
      FROM memories
      WHERE user_key = ${userKey}
      ORDER BY embedding <-> ${vectorLiteral(emb)}::vector
      LIMIT 5
    `;
    return { hits: res.rows.map(r => r.text) };
  },
};

export const trippTools = [memoryWrite, memorySearch];
