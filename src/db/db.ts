// db/db.ts
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

const sql = neon(process.env.POSTGRES_URL!);

// 👇 add Schema generic + schema option
export const db = drizzle<typeof schema>(sql, { schema });

export { schema };
export type Schema = typeof schema;
