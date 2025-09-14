CREATE SCHEMA IF NOT EXISTS "tripp";
--> statement-breakpoint
CREATE TABLE "tripp"."chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" varchar(64) NOT NULL,
	"role" varchar(16) NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tripp"."chat_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" varchar(64) NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"user_id" varchar(64),
	"tier" varchar(32) DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "chat_sessions_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "tripp"."client_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"user_id" varchar(64),
	"ip_hash" varchar(64),
	"date" varchar(10) NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tripp"."memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"namespace" varchar(64) DEFAULT 'default' NOT NULL,
	"key" varchar(128) NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "chat_messages_session_idx" ON "tripp"."chat_messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "chat_messages_created_idx" ON "tripp"."chat_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "chat_sessions_user_idx" ON "tripp"."chat_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_sessions_client_idx" ON "tripp"."chat_sessions" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "chat_sessions_created_idx" ON "tripp"."chat_sessions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "client_usage_key_idx" ON "tripp"."client_usage" USING btree ("client_id","user_id","date");--> statement-breakpoint
CREATE INDEX "memories_user_ns_key_idx" ON "tripp"."memories" USING btree ("user_id","namespace","key");