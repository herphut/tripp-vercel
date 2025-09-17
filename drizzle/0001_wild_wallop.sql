CREATE TABLE "tripp"."audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"route" varchar(256) NOT NULL,
	"status" integer NOT NULL,
	"client_id" varchar(128),
	"user_id" varchar(128),
	"session_id" varchar(64),
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tripp"."users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"memory_opt_in" boolean DEFAULT false NOT NULL,
	"tier" varchar(32) DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "tripp"."chat_sessions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "tripp"."audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_route_idx" ON "tripp"."audit_logs" USING btree ("route");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "tripp"."users" USING btree ("email");