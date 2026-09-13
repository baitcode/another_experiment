CREATE TABLE "post_comments_sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"post_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"lease_token" uuid,
	CONSTRAINT "post_comments_sync_jobs_platform_check" CHECK ("post_comments_sync_jobs"."platform" in ('telegram'))
);
--> statement-breakpoint
CREATE TABLE "post_comments_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"post_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"job_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	CONSTRAINT "post_comments_sync_runs_platform_check" CHECK ("post_comments_sync_runs"."platform" in ('telegram')),
	CONSTRAINT "post_comments_sync_runs_status_check" CHECK ("post_comments_sync_runs"."status" in ('running', 'success', 'failure'))
);
--> statement-breakpoint
CREATE TABLE "telegram_comments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"post_id" uuid NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"reply_to_message_id" bigint NOT NULL,
	"reply_to" uuid,
	"author_id" bigint,
	"author_username" text,
	"author_name" text,
	"text" text NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_comments_post_message_uniq" UNIQUE("post_id","telegram_message_id")
);
--> statement-breakpoint
CREATE TABLE "telegram_posts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"username" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"post_type" text NOT NULL,
	"message_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"forum_topic_id" bigint,
	"discussion_chat_id" bigint,
	"discussion_message_id" bigint,
	"last_synced_at" timestamp with time zone,
	"last_synced_message_id" bigint,
	"sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "telegram_posts_post_type_check" CHECK ("telegram_posts"."post_type" in ('channel', 'forum', 'supergroup'))
);
--> statement-breakpoint
ALTER TABLE "post_comments_sync_runs" ADD CONSTRAINT "post_comments_sync_runs_job_id_post_comments_sync_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."post_comments_sync_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_comments" ADD CONSTRAINT "telegram_comments_post_id_telegram_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."telegram_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_comments" ADD CONSTRAINT "telegram_comments_reply_to_telegram_comments_id_fk" FOREIGN KEY ("reply_to") REFERENCES "public"."telegram_comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "post_comments_sync_jobs_platform_post_uniq" ON "post_comments_sync_jobs" USING btree ("platform","post_id");--> statement-breakpoint
CREATE INDEX "post_comments_sync_jobs_due_idx" ON "post_comments_sync_jobs" USING btree ("locked_at" NULLS FIRST) WHERE "post_comments_sync_jobs"."is_active";--> statement-breakpoint
CREATE INDEX "post_comments_sync_runs_post_idx" ON "post_comments_sync_runs" USING btree ("post_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "telegram_comments_reply_to_idx" ON "telegram_comments" USING btree ("reply_to","id") WHERE "telegram_comments"."reply_to" is not null;--> statement-breakpoint
CREATE INDEX "telegram_comments_top_level_idx" ON "telegram_comments" USING btree ("post_id","id") WHERE "telegram_comments"."reply_to" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_posts_username_channel_message_uniq" ON "telegram_posts" USING btree ("username","channel_id","message_id");