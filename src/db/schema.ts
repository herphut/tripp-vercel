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

/* ------------------------------------------------------------------ */
/* USER PREFERENCES (per-user consent + audit fields)                  */
/* ------------------------------------------------------------------ */
export const userPrefs = tripp.table(
  "user_prefs",
  {
    // user_id is the PK so we can upsert on conflict(user_id)
    userId: text("user_id").primaryKey(),
    memoryOptIn: boolean("memory_opt_in").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  }
);

/* ------------------------------------------------------------------ */
/* USERS                                                               */
/* ------------------------------------------------------------------ */
export const users = tripp.table(
  "users",
  {
    id: serial("id").primaryKey(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    tier: varchar("tier", { length: 32 }).notNull().default("free"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // (No direct userPrefs column here; that's a relation at the app level)
  },
  (t) => ({
    byEmail: index("users_email_idx").on(t.email),
  })
);

/* ------------------------------------------------------------------ */
/* CHAT SESSIONS                                                       */
/* ------------------------------------------------------------------ */
export const chatSessions = tripp.table(
  "chat_sessions",
  {
    id: serial("id").primaryKey(),
    sessionId: varchar("session_id", { length: 64 }).notNull().unique(),
    clientId: varchar("client_id", { length: 64 }),
    userId: varchar("user_id", { length: 64 }), // keep as varchar(64) to match your SSO bridge
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
  },
  (t) => ({
    byUser:   index("chat_sessions_user_idx").on(t.userId),
    byClient: index("chat_sessions_client_idx").on(t.clientId),
    byCreated:index("chat_sessions_created_idx").on(t.createdAt),
  })
);

/* ------------------------------------------------------------------ */
/* CHAT MESSAGES                                                       */
/* ------------------------------------------------------------------ */
export const chatMessages = tripp.table(
  "chat_messages",
  {
    id: serial("id").primaryKey(),
    sessionId: varchar("session_id", { length: 64 }).notNull(),
    userId: varchar("user_id", { length: 64 }), // optional; helps with exports/analytics
    role: varchar("role", { length: 16 }).notNull(), // 'user'|'assistant'|'system'

    // allow NULL so we can support redaction
    content: text("content"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    // optional redaction/telemetry helpers
    contentLen: integer("content_len"),
    contentSha256: varchar("content_sha256", { length: 64 }), // hex sha256 length
    contentRedacted: boolean("content_redacted").notNull().default(false),
  },
  (t) => ({
    bySession: index("chat_messages_session_idx").on(t.sessionId),
    byCreated: index("chat_messages_created_idx").on(t.createdAt),
  })
);

/* ------------------------------------------------------------------ */
/* MEMORIES (long-term K/V per user + namespace)                       */
/* ------------------------------------------------------------------ */
export const memories = tripp.table(
  "memories",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id", { length: 64 }).notNull(),
    namespace: varchar("namespace", { length: 64 }).notNull().default("default"),
    key: varchar("key", { length: 128 }).notNull(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUserNsKey: index("memories_user_ns_key_idx").on(t.userId, t.namespace, t.key),
    // When you're ready to enforce uniqueness, switch to:
    // unique("memories_user_ns_key_uq").on(t.userId, t.namespace, t.key),
  })
);

/* ------------------------------------------------------------------ */
/* CLIENT USAGE (daily counters)                                       */
/* ------------------------------------------------------------------ */
export const clientUsage = tripp.table(
  "client_usage",
  {
    id: serial("id").primaryKey(),
    clientId: varchar("client_id", { length: 64 }).notNull(),
    userId: varchar("user_id", { length: 64 }),
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

/* ------------------------------------------------------------------ */
/* AUDIT LOGS                                                          */
/* ------------------------------------------------------------------ */
export const auditLogs = tripp.table(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    route: varchar("route", { length: 256 }).notNull(),
    status: integer("status").notNull(),
    clientId: varchar("client_id", { length: 128 }),
    userId: varchar("user_id", { length: 128 }),
    sessionId: varchar("session_id", { length: 64 }),
    latencyMs: integer("latency_ms"),
    error: text("error"),
  },
  (t) => ({
    byCreated: index("audit_logs_created_idx").on(t.createdAt),
    byRoute: index("audit_logs_route_idx").on(t.route),
  })
);
