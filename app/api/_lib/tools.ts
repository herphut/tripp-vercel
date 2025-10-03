// app/api/_lib/tools.ts
import "server-only";
import type { NextRequest } from "next/server";

// ---------- Compatibility Types (kept so existing imports don't break) ----------
export type ToolContext = { request: NextRequest };

export interface Tool<Args, Result> {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  execute(args: Args, ctx: ToolContext): Promise<Result>;
}

// No custom/function tools right now (we're using built-ins instead)
export const trippTools: Tool<any, any>[] = [];

// ---------- Built-in tools exposer ----------
// Env examples:
//   TRIPP_DISABLE_TOOLS=1                 -> disable all tools
//   TRIPP_BUILTIN_TOOLS=image_generation,web_search,file_search
//
// Notes:
// - We hide tools for guests (anon) by default.
// - You can pass hints (wantsImages / wantsWeb / wantsFiles) so we only expose
//   relevant tools to the model on that turn (helps reduce “I can’t do X” noise).

type BuiltinName = "image_generation" | "web_search" | "file_search";
const VALID_BUILTINS = new Set<BuiltinName>([
  "image_generation",
  "web_search",
  "file_search",
]);

function parseAllowlist(): Set<BuiltinName> {
  const raw = (process.env.TRIPP_BUILTIN_TOOLS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const set = new Set<BuiltinName>();
  for (const name of raw) {
    if (VALID_BUILTINS.has(name as BuiltinName)) {
      set.add(name as BuiltinName);
    }
  }
  return set;
}

export function buildToolsForModel(opts: {
  isGuest: boolean;
  wantsImages?: boolean;
  wantsWeb?: boolean;
  wantsFiles?: boolean;
}) {
  // global kill switch
  if (process.env.TRIPP_DISABLE_TOOLS === "1") return undefined;

  // guests: no tools
  if (opts.isGuest) return undefined;

  const allow = parseAllowlist();
  if (allow.size === 0) return undefined; // nothing allowed => nothing exposed

  // Gate by intent hints (optional, conservative)
  const tools: any[] = [];

  // image generation
  if (allow.has("image_generation") && (opts.wantsImages ?? false)) {
    tools.push({ type: "image_generation" });
  }

  // web search
  if (allow.has("web_search") && (opts.wantsWeb ?? true)) {
    // default true because general chat often benefits from it
    tools.push({ type: "web_search" });
  }

  // file search
  if (allow.has("file_search") && (opts.wantsFiles ?? false)) {
    tools.push({ type: "file_search" });
  }

  return tools.length ? tools : undefined;
}
