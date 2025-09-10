// src/agents/tools.ts
import OpenAI from "openai";
import { sql } from "@vercel/postgres";
import type { NextRequest } from "next/server";
import { redactPII } from "@/lib/redact";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

/** Minimal Tool shape */
type Tool = {
  name: string;
  description?: string;
  input_schema?: any;
  execute: (args: any, ctx: { request: NextRequest }) => Promise<any>;
};

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

/** Format embedding array into Postgres vector literal */
function vectorLiteral(emb: number[]): string {
  return `[${emb.join(",")}]`;
}

/** ---- memory_write ---- */
export const memoryWrite: Tool = {
  name: "memory_write",
  description:
    "Store a short, durable memory for this user (PII is redacted before saving).",
  input_schema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  async execute({ text }: { text: string }, { request }) {
    if (!text || typeof text !== "string") {
      return { ok: false, error: "invalid_text" };
    }

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
export const memorySearch: Tool = {
  name: "memory_search",
  description:
    "Retrieve up to 5 user-specific memories that are relevant to the query.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  async execute(
    { query }: { query: string },
    { request }: { request: NextRequest }
  ) {
    if (!query || typeof query !== "string") {
      return { hits: [] };
    }

    const q = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });
    const emb = q.data[0].embedding as number[];
    const userKey = userKeyFromRequest(request);

    const rows = await sql`
      SELECT text
      FROM memories
      WHERE user_key = ${userKey}
      ORDER BY embedding <-> ${vectorLiteral(emb)}::vector
      LIMIT 5
    `;

    return { hits: rows.rows.map((r: any) => r.text) };
  },
};

export const trippTools: Tool[] = [memoryWrite, memorySearch];
