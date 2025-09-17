import { db } from "@/db/db";
import { sql } from "drizzle-orm";
import { redactPII } from "@/lib/redact";

type AuditInput = {
  route: string;
  status: number;
  client_id: string | null;
  user_id?: string | null;
  session_id?: string | null;
  latency_ms?: number | null;
  error?: string | null;
};

export async function auditLog(a: AuditInput) {
  try {
    await db.execute(sql`
      insert into tripp.audit_logs
        (route, status, client_id, user_id, session_id, latency_ms, error)
      values
        (${a.route}, ${a.status}, ${a.client_id}, ${a.user_id ?? null}, ${a.session_id ?? null}, ${a.latency_ms ?? null}, ${a.error ? redactPII(a.error) : null})
    `);
  } catch {}
}


