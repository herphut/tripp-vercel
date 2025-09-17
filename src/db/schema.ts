import {
  pgSchema,
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  index,
} from "drizzle-orm/pg-core";

export const tripp = pgSchema("tripp");

/**
 * USERS
 * - Keeps your integer PK
 * - memoryOptIn already present (source of truth for signed-in users)
 */
export const users = tripp.table(
  "users",
  {
    id: serial("id").primaryKey(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    memoryOptIn: boolean("memory_opt_in").default(false).notNull(),
    tier: varchar("tier", { length: 32 }).default("free").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byEmail: index("users_email_idx").on(t.email),
  })
);

/**
 * CHAT SESSIONS
 * - Adds memoryOptIn snapshot at the session level (for anon & fast reads)
 * - Leaves userId as varchar(64) to match your current SSO/bridge flow
 */
export const chatSessions = tripp.table(
  "chat_sessions",
  {
    id: serial("id").primaryKey(),
    sessionId: varchar("session_id", { length: 64 }).notNull().unique(),
    clientId: varchar("client_id", { length: 64 }).notNull(),
    userId: varchar("user_id", { length: 64 }),
    /** NEW: mirrors consent at session creation / toggle time */
    memoryOptIn: boolean("memory_opt_in").default(false).notNull(),
    tier: varchar("tier", { length: 32 }).default("free").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => ({
    byUser: index("chat_sessions_user_idx").on(t.userId),
    byClient: index("chat_sessions_client_idx").on(t.clientId),
    byCreated: index("chat_sessions_created_idx").on(t.createdAt),
  })
);

/**
 * CHAT MESSAGES
 * - No structural change; uses sessionId as FK (logical)
 */
export const chatMessages = tripp.table(
  "chat_messages",
  {
    id: serial("id").primaryKey(),
    sessionId: varchar("session_id", { length: 64 }).notNull(),
    role: varchar("role", { length: 16 }).notNull(), // 'user'|'assistant'|'system'
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySession: index("chat_messages_session_idx").on(t.sessionId),
    byCreated: index("chat_messages_created_idx").on(t.createdAt),
  })
);

/**
 * MEMORIES (long-term K/V per user + namespace)
 * - Tighten the uniqueness on (userId, namespace, key) to avoid dup keys
 *   If you already have dups, run a cleanup before applying the UNIQUE.
 */
export const memories = tripp.table(
  "memories",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id", { length: 64 }).notNull(),
    namespace: varchar("namespace", { length: 64 }).default("default").notNull(),
    key: varchar("key", { length: 128 }).notNull(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byUserNsKey: index("memories_user_ns_key_idx").on(t.userId, t.namespace, t.key),
    // Optional hard guard (enable when clean): unique("memories_user_ns_key_uq").on(t.userId, t.namespace, t.key),
  })
);

/**
 * CLIENT USAGE (daily counters)
 */
export const clientUsage = tripp.table(
  "client_usage",
  {
    id: serial("id").primaryKey(),
    clientId: varchar("client_id", { length: 64 }).notNull(),
    userId: varchar("user_id", { length: 64 }),
    ipHash: varchar("ip_hash", { length: 64 }), // hashed IP if needed
    date: varchar("date", { length: 10 }).notNull(), // YYYY-MM-DD
    requests: integer("requests").default(0).notNull(),
    tokensIn: integer("tokens_in").default(0).notNull(),
    tokensOut: integer("tokens_out").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byKey: index("client_usage_key_idx").on(t.clientId, t.userId, t.date),
  })
);

/**
 * AUDIT LOGS
 */
export const auditLogs = tripp.table(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    route: varchar("route", { length: 256 }).notNull(),
    status: integer("status").notNull(),
    clientId: varchar("client_id", { length: 128 }),
    userId: varchar("user_id", { length: 128 }),
    sessionId: varchar("session_id", { length: 64 }),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCreated: index("audit_logs_created_idx").on(t.createdAt),
    byRoute: index("audit_logs_route_idx").on(t.route),
  })
);
