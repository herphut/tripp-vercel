// schema.ts
import {
  pgSchema, pgTable, serial, bigserial, varchar, text, timestamp, integer, boolean, index
} from "drizzle-orm/pg-core";

export const tripp = pgSchema("tripp");

// 1) User prefs (SSO user_id is the PK)
export const userPrefs = tripp.table("user_prefs", {
  userId: text("user_id").primaryKey(),
  memoryOptIn: boolean("memory_opt_in").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 2) Chat sessions
export const chatSessions = tripp.table(
  "chat_sessions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: varchar("session_id", { length: 64 }).notNull().unique(),
    clientId: varchar("client_id", { length: 64 }),
    userId: text("user_id"), // <- unify on SSO text id
    tier: varchar("tier", { length: 32 }).notNull().default("free"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    lastSeen:  timestamp("last_seen",  { withTimezone: true }).defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    deviceHash: varchar("device_hash", { length: 128 }),
    uaHash:     varchar("ua_hash",     { length: 128 }),
    ipHash:     varchar("ip_hash",     { length: 128 }),

    jti: varchar("jti", { length: 255 }),
    kid: varchar("kid", { length: 255 }),
    iss: varchar("iss", { length: 255 }),
    aud: varchar("aud", { length: 255 }),

    title: varchar("title", { length: 120 }),
    firstUserAt: timestamp("first_user_at", { withTimezone: true }),
  },
  (t) => ({
    byUser:   index("chat_sessions_user_idx").on(t.userId),
    byClient: index("chat_sessions_client_idx").on(t.clientId),
    byCreated:index("chat_sessions_created_idx").on(t.createdAt),
  })
);

// 3) Chat messages
export const chatMessages = tripp.table(
  "chat_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: varchar("session_id", { length: 64 }).notNull(),
    userId: text("user_id"), // optional; still SSO text when present
    role: varchar("role", { length: 16 }).notNull(), // 'user'|'assistant'|'system'
    content: text("content"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    contentLen: integer("content_len"),
    contentSha256: varchar("content_sha256", { length: 64 }),
    contentRedacted: boolean("content_redacted").notNull().default(false),
  },
  (t) => ({
    bySession: index("chat_messages_session_idx").on(t.sessionId),
    byCreated: index("chat_messages_created_idx").on(t.createdAt),
  })
);

// 4) Memories (KV)
export const memories = tripp.table(
  "memories",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id").notNull(),
    namespace: varchar("namespace", { length: 64 }).notNull().default("default"),
    key: varchar("key", { length: 128 }).notNull(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUserNsKey: index("memories_user_ns_key_idx").on(t.userId, t.namespace, t.key),
    // Later: unique("memories_user_ns_key_uq").on(t.userId, t.namespace, t.key),
  })
);

// 5) Client usage
export const clientUsage = tripp.table(
  "client_usage",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    clientId: varchar("client_id", { length: 64 }).notNull(),
    userId: text("user_id"),
    ipHash: varchar("ip_hash", { length: 64 }),
    date: varchar("date", { length: 10 }).notNull(), // YYYY-MM-DD
    requests: integer("requests").notNull().default(0),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byKey: index("client_usage_key_idx").on(t.clientId, t.userId, t.date),
  })
);

// 6) Audit logs
export const auditLogs = tripp.table(
  "audit_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    route: varchar("route", { length: 256 }).notNull(),
    status: integer("status").notNull(),
    clientId: varchar("client_id", { length: 128 }),
    userId: text("user_id"),
    sessionId: varchar("session_id", { length: 64 }),
    latencyMs: integer("latency_ms"),
    error: text("error"),
  },
  (t) => ({
    byCreated: index("audit_logs_created_idx").on(t.createdAt),
    byRoute: index("audit_logs_route_idx").on(t.route),
  })
);
