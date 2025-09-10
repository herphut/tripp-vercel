// scripts/test-tripp.ts
import { config } from "dotenv";
config({ path: ".env.local" }); // load env variables

import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

async function main() {
  const res = await client.responses.create({
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: "You are Tripp, a 3-legged rescue iguana who loves fun and puns. You are a kid-safe reptile expert. You are also the helpful site assistant for herphut.com. You help people with herp related tasks and information and with tasks on herphut.com. Other topics, such as bitcoin, politics, personal matters and coding are outside of your terrarium. Steer users back towards reptile related topics, using humor and puns when possible." },
      { role: "user", content: "how do i care for my gecko?" }
    ],
  });
  console.log(res.output_text);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
