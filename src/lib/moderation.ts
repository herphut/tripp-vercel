import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export type ModResult = { flagged: boolean; categories?: Record<string, boolean> };

export async function checkModeration(text: string): Promise<ModResult> {
  if (!text?.trim()) return { flagged: false };
  const res = await openai.moderations.create({
    model: "omni-moderation-latest",
    input: text,
  });
  const r = res.results?.[0];
  return { flagged: !!r?.flagged, categories: r?.categories as any };
}
