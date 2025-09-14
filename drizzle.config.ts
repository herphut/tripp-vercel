import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",                 // migrations folder
  dialect: "postgresql",
  dbCredentials: { url: process.env.POSTGRES_URL! },
  verbose: true,
  strict: true,
} satisfies Config;
