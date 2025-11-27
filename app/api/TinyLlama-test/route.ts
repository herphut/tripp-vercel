// app/api/tinyllama-test/route.ts
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const { prompt } = await req.json();

  const res = await fetch(process.env.TINYLLAMA_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "tinyllama",
      prompt,
      stream: false,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json(
      { error: `TinyLlama error: ${res.status} ${text}` },
      { status: 500 }
    );
  }

  const data = await res.json();
  return NextResponse.json({ response: data.response ?? data.output ?? "" });
}
