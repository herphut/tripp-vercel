import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { TRIPP_PROMPT } from "@/agents/trippPrompt";
import { checkModeration } from "@/lib/moderation";
import { rateLimit } from "@/lib/ratelimit";
import { memoryWrite, memorySearch } from "@/agents/tools";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Simple tool registry using your existing functions
const TOOL_REGISTRY: Record<
  string,
  (args: any, ctx: { request: NextRequest }) => Promise<any>
> = {
  memory_write: async (args, ctx) => memoryWrite.execute(args, { request: ctx.request }),
  memory_search: async (args, ctx) => memorySearch.execute(args, { request: ctx.request }),
};

function clientKey(req: NextRequest) {
  const xf = req.headers.get("x-forwarded-for");
  const ip = xf?.split(",")[0]?.trim() || "anon";
  return `${ip}:/api/chat`;
}

export async function POST(req: NextRequest) {
  // 1) Rate-limit
  const { allowed, remaining, reset } = await rateLimit(clientKey(req));
  const rl = {
    "X-RateLimit-Limit": "30",
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(reset),
  };
  if (!allowed) {
    return new NextResponse(
      JSON.stringify({
        error: "too_many_requests",
        message: "Whoa there, speedy gecko! You’ve hit the limit—try again soon.",
      }),
      {
        status: 429,
        headers: {
          ...rl,
          "Retry-After": String(Math.max(reset - Math.floor(Date.now() / 1000), 0)),
          "Content-Type": "application/json",
        },
      }
    );
  }

  // 2) Parse input
  const { messages = [] } = await req.json();

  // 3) Moderation (user input pre-check)
  const lastUser = [...messages].reverse().find((m: any) => m.role === "user");
  const userText =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : lastUser?.content?.[0]?.text ?? "";

  const mod = await checkModeration(userText);
  if (mod.flagged) {
    return new NextResponse(
      JSON.stringify({
        error: "moderation_block",
        message:
          "I can’t help with that. Let’s stick to kid-safe herp care and fun facts! 🦎",
      }),
      { status: 400, headers: { ...rl, "Content-Type": "application/json" } }
    );
  }

  // 4) Consent guard (tell the model what it may do)
  const consent = req.cookies.get("tripp_mem_consent")?.value === "1";
  const guard = {
    role: "system",
    content: consent
      ? "Memory consent: TRUE. You may call the tool `memory_write` to remember brief facts when helpful. Prefer concise notes."
      : "Memory consent: FALSE. Do NOT call `memory_write`. You may call `memory_search` only if it won’t expose private info.",
  };

  // 5) First model call with tool definitions (auto tool selection)
  const first = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [{ role: "system", content: TRIPP_PROMPT }, guard as any, ...messages],
    tools: [
      {
        type: "function",
        name: "memory_write",
        description: "Store a short, durable memory for this user (PII is auto-redacted).",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      {
        type: "function",
        name: "memory_search",
        description: "Retrieve up to 5 user-specific memories relevant to a query.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ] as any,
    tool_choice: "auto" as any,
  });

  // 6) If model requested tool outputs, execute them then submit results
  //    The Responses API surfaces this via `required_action.type === "submit_tool_outputs"`
  if (
    // @ts-expect-error: shape is not fully typed in SDK
    first.required_action?.type === "submit_tool_outputs" &&
    // @ts-expect-error
    Array.isArray(first.required_action?.submit_tool_outputs?.tool_calls)
  ) {
    // @ts-expect-error
    const toolCalls = first.required_action.submit_tool_outputs.tool_calls as Array<{
      id: string;
      name: string;
      arguments: string;
    }>;

    const outputs = [];
    for (const call of toolCalls) {
      const impl = TOOL_REGISTRY[call.name];
      if (!impl) {
        outputs.push({ tool_call_id: call.id, output: JSON.stringify({ error: "unknown_tool" }) });
        continue;
      }
      let parsed: any = {};
      try {
        parsed = JSON.parse(call.arguments || "{}");
      } catch {
        // ignore; parsed stays {}
      }
      try {
        const result = await impl(parsed, { request: req });
        outputs.push({ tool_call_id: call.id, output: JSON.stringify(result ?? {}) });
      } catch (e: any) {
        outputs.push({
          tool_call_id: call.id,
          output: JSON.stringify({ error: "tool_failed", message: String(e?.message || e) }),
        });
      }
    }

    // Submit tool outputs to get the final assistant answer
    // @ts-expect-error: submitToolOutputs not declared in current SDK typings
    const final = await openai.responses.submitToolOutputs(first.id, {
      tool_outputs: outputs,
    });

    const text = (final as any).output_text ?? "";
    return new NextResponse(JSON.stringify({ text }), {
      status: 200,
      headers: { ...rl, "Content-Type": "application/json" },
    });
  }

  // 7) No tools needed — return the model’s answer
  const text = (first as any).output_text ?? "";
  return new NextResponse(JSON.stringify({ text }), {
    status: 200,
    headers: { ...rl, "Content-Type": "application/json" },
  });
}
