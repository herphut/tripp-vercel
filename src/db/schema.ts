import {
  pgSchema, pgTable, serial, varchar, text, timestamp, integer, boolean, index,
} from "drizzle-orm/pg-core";

export const tripp = pgSchema("tripp");

/** Sessions: browser or WP-backed, labels with client & tier */
export const chatSessions = tripp.table("chat_sessions", {
  id: serial("id").primaryKey(),
  sessionId: varchar("session_id", { length: 64 }).notNull().unique(),
  clientId: varchar("client_id", { length: 64 }).notNull(),
  userId: varchar("user_id", { length: 64 }),
  tier: varchar("tier", { length: 32 }).default("free").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (t) => ({
  byUser: index("chat_sessions_user_idx").on(t.userId),
  byClient: index("chat_sessions_client_idx").on(t.clientId),
  byCreated: index("chat_sessions_created_idx").on(t.createdAt),
}));

/** Messages: chat history for a session */
export const chatMessages = tripp.table("chat_messages", {
  id: serial("id").primaryKey(),
  sessionId: varchar("session_id", { length: 64 }).notNull(),
  role: varchar("role", { length: 16 }).notNull(), // 'user'|'assistant'|'system'
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  bySession: index("chat_messages_session_idx").on(t.sessionId),
  byCreated: index("chat_messages_created_idx").on(t.createdAt),
}));

/** Key/value long-term memory (scoped to user + namespace) */
export const memories = tripp.table("memories", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id", { length: 64 }).notNull(),
  namespace: varchar("namespace", { length: 64 }).default("default").notNull(),
  key: varchar("key", { length: 128 }).notNull(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byUserNsKey: index("memories_user_ns_key_idx").on(t.userId, t.namespace, t.key),
}));

/** Per-client/user/IP counters (optional; Redis will handle hot path) */
export const clientUsage = tripp.table("client_usage", {
  id: serial("id").primaryKey(),
  clientId: varchar("client_id", { length: 64 }).notNull(),
  userId: varchar("user_id", { length: 64 }),
  ipHash: varchar("ip_hash", { length: 64 }), // store hashed IP if needed
  date: varchar("date", { length: 10 }).notNull(), // YYYY-MM-DD
  requests: integer("requests").default(0).notNull(),
  tokensIn: integer("tokens_in").default(0).notNull(),
  tokensOut: integer("tokens_out").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byKey: index("client_usage_key_idx").on(t.clientId, t.userId, t.date),
}));
