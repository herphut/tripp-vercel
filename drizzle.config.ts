import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",                 // migrations folder
  dialect: "postgresql",
  dbCredentials: { url: process.env.POSTGRES_URL! },
  verbose: true,
  strict: true,
  // optional, but helps introspect focus:
  // tablesFilter: ["tripp.*"],    // only pull tables from the tripp schema,
} satisfies Config;
