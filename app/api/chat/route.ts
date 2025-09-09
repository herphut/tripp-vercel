// app/api/chat/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod";

const MessagesSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().min(1),
      })
    )
    .min(1),
});
type MessagesPayload = z.infer<typeof MessagesSchema>;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!, // set in Vercel Project → Settings → Environment Variables
});

export async function POST(req: NextRequest) {
  try {
    const json = (await req.json()) as unknown;
    const parsed = MessagesSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", issues: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { messages }: MessagesPayload = parsed.data;

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.7,
    });

    const reply = resp.choices[0]?.message?.content ?? "";

    return NextResponse.json({
      reply,
      usage: resp.usage, // helpful for monitoring
    });
  } catch (err) {
    console.error("Chat route error:", err);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
