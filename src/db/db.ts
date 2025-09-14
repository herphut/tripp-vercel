import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

const sql = neon(process.env.POSTGRES_URL!); // Neon serverless (HTTP/WebSocket)
export const db = drizzle(sql, { schema });
export {schema};
export type Schema = typeof schema;
