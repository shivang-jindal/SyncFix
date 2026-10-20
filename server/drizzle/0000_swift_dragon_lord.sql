CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"metadata_json" jsonb,
	"request_id" text,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"job_type" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"completed_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_test_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"status" text NOT NULL,
	"tested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"latency_ms" integer,
	"error_code" text,
	"safe_message" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"environment" text DEFAULT 'production' NOT NULL,
	"status" text DEFAULT 'not_configured' NOT NULL,
	"encrypted_credentials_json" text,
	"settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credential_keys_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scopes_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"template_type" text NOT NULL,
	"to_address" text NOT NULL,
	"from_address" text NOT NULL,
	"subject" text NOT NULL,
	"body_text" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"failure_code" text,
	"safe_failure_message" text,
	"idempotency_key" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"subject" text NOT NULL,
	"body_html" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_rate_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"invited_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"retention_days" integer DEFAULT 90 NOT NULL,
	"issue_notification_emails_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notify_on_severity" text DEFAULT 'critical' NOT NULL,
	"redact_fields_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"country_code" text DEFAULT 'US' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"base_currency" text DEFAULT 'USD' NOT NULL,
	"logo_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repair_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"initiated_by" uuid,
	"action" text NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"result_summary_json" jsonb,
	"error_code" text,
	"safe_message" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"active_organization_id" uuid,
	"user_agent" text,
	"ip_address" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sync_job_id" uuid NOT NULL,
	"sync_run_id" uuid,
	"record_key" text,
	"issue_type" text NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"error_code" text,
	"safe_message" text DEFAULT '' NOT NULL,
	"redacted_payload_json" jsonb,
	"repaired_payload_json" jsonb,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"retryable" boolean DEFAULT true NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source_connection_id" uuid NOT NULL,
	"destination_connection_id" uuid NOT NULL,
	"source_entity" text NOT NULL,
	"destination_entity" text NOT NULL,
	"mode" text DEFAULT 'one_way' NOT NULL,
	"schedule_cron" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"conflict_policy" text DEFAULT 'manual_review' NOT NULL,
	"batch_size" integer DEFAULT 50 NOT NULL,
	"retry_policy_json" jsonb DEFAULT '{"mode":"safe_only","maxAttempts":3,"backoffSeconds":60}'::jsonb NOT NULL,
	"filters_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checkpoint_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_locks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sync_job_id" uuid NOT NULL,
	"owner_token" text NOT NULL,
	"run_id" uuid,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sync_job_id" uuid NOT NULL,
	"source_path" text NOT NULL,
	"destination_path" text NOT NULL,
	"source_type" text DEFAULT 'string' NOT NULL,
	"destination_type" text DEFAULT 'string' NOT NULL,
	"transform_type" text DEFAULT 'none' NOT NULL,
	"transform_config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"default_value_json" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sync_job_id" uuid NOT NULL,
	"source_record_key" text NOT NULL,
	"destination_record_key" text,
	"source_version" text,
	"destination_version" text,
	"last_synced_at" timestamp with time zone,
	"last_hash" text,
	"status" text DEFAULT 'synced' NOT NULL,
	"redacted_source_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sync_run_id" uuid NOT NULL,
	"step_name" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"counts_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"safe_message" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sync_job_id" uuid NOT NULL,
	"trigger_type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"fetched_count" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"cursor_start_json" jsonb,
	"cursor_end_json" jsonb,
	"duration_ms" integer,
	"error_code" text,
	"safe_message" text,
	"request_id" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"public_endpoint_id" text NOT NULL,
	"encrypted_secret" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_received_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"external_event_id" text,
	"payload_hash" text NOT NULL,
	"redacted_payload_json" jsonb,
	"status" text DEFAULT 'received' NOT NULL,
	"error_code" text,
	"safe_message" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_test_runs" ADD CONSTRAINT "connection_test_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_test_runs" ADD CONSTRAINT "connection_test_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_rate_limits" ADD CONSTRAINT "integration_rate_limits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_rate_limits" ADD CONSTRAINT "integration_rate_limits_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_attempts" ADD CONSTRAINT "repair_attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_attempts" ADD CONSTRAINT "repair_attempts_issue_id_sync_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."sync_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_attempts" ADD CONSTRAINT "repair_attempts_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_organization_id_organizations_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_issues" ADD CONSTRAINT "sync_issues_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_issues" ADD CONSTRAINT "sync_issues_sync_job_id_sync_jobs_id_fk" FOREIGN KEY ("sync_job_id") REFERENCES "public"."sync_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_issues" ADD CONSTRAINT "sync_issues_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_issues" ADD CONSTRAINT "sync_issues_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_source_connection_id_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_destination_connection_id_connections_id_fk" FOREIGN KEY ("destination_connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_locks" ADD CONSTRAINT "sync_locks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_locks" ADD CONSTRAINT "sync_locks_sync_job_id_sync_jobs_id_fk" FOREIGN KEY ("sync_job_id") REFERENCES "public"."sync_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_locks" ADD CONSTRAINT "sync_locks_run_id_sync_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_mappings" ADD CONSTRAINT "sync_mappings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_mappings" ADD CONSTRAINT "sync_mappings_sync_job_id_sync_jobs_id_fk" FOREIGN KEY ("sync_job_id") REFERENCES "public"."sync_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_records" ADD CONSTRAINT "sync_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_records" ADD CONSTRAINT "sync_records_sync_job_id_sync_jobs_id_fk" FOREIGN KEY ("sync_job_id") REFERENCES "public"."sync_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_run_steps" ADD CONSTRAINT "sync_run_steps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_run_steps" ADD CONSTRAINT "sync_run_steps_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_sync_job_id_sync_jobs_id_fk" FOREIGN KEY ("sync_job_id") REFERENCES "public"."sync_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_org_created_idx" ON "audit_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "background_jobs_claim_idx" ON "background_jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "background_jobs_org_idx" ON "background_jobs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "background_jobs_idempotency_idx" ON "background_jobs" USING btree ("idempotency_key") WHERE "background_jobs"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "connection_test_runs_connection_idx" ON "connection_test_runs" USING btree ("connection_id","tested_at");--> statement-breakpoint
CREATE INDEX "connections_org_status_idx" ON "connections" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "connections_org_provider_idx" ON "connections" USING btree ("organization_id","provider");--> statement-breakpoint
CREATE INDEX "email_messages_org_status_idx" ON "email_messages" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "email_messages_idempotency_idx" ON "email_messages" USING btree ("idempotency_key") WHERE "email_messages"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_rate_limits_window_idx" ON "integration_rate_limits" USING btree ("connection_id","window_start");--> statement-breakpoint
CREATE INDEX "integration_rate_limits_org_idx" ON "integration_rate_limits" USING btree ("organization_id","window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_idx" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invitations_org_idx" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user_idx" ON "memberships" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_token_hash_idx" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "repair_attempts_issue_idx" ON "repair_attempts" USING btree ("issue_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_idx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sync_issues_org_status_idx" ON "sync_issues" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "sync_issues_job_status_idx" ON "sync_issues" USING btree ("sync_job_id","status");--> statement-breakpoint
CREATE INDEX "sync_issues_last_seen_idx" ON "sync_issues" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "sync_issues_record_idx" ON "sync_issues" USING btree ("sync_job_id","record_key");--> statement-breakpoint
CREATE INDEX "sync_jobs_org_enabled_idx" ON "sync_jobs" USING btree ("organization_id","enabled");--> statement-breakpoint
CREATE INDEX "sync_jobs_org_name_idx" ON "sync_jobs" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_locks_job_idx" ON "sync_locks" USING btree ("sync_job_id");--> statement-breakpoint
CREATE INDEX "sync_locks_expires_idx" ON "sync_locks" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sync_mappings_job_idx" ON "sync_mappings" USING btree ("sync_job_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_mappings_job_destination_idx" ON "sync_mappings" USING btree ("sync_job_id","destination_path");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_records_job_source_key_idx" ON "sync_records" USING btree ("sync_job_id","source_record_key");--> statement-breakpoint
CREATE INDEX "sync_records_job_status_idx" ON "sync_records" USING btree ("sync_job_id","status");--> statement-breakpoint
CREATE INDEX "sync_run_steps_run_idx" ON "sync_run_steps" USING btree ("sync_run_id","sort_order");--> statement-breakpoint
CREATE INDEX "sync_runs_job_started_idx" ON "sync_runs" USING btree ("sync_job_id","started_at");--> statement-breakpoint
CREATE INDEX "sync_runs_org_started_idx" ON "sync_runs" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "sync_runs_org_status_idx" ON "sync_runs" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_endpoints_public_id_idx" ON "webhook_endpoints" USING btree ("public_endpoint_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_org_idx" ON "webhook_endpoints" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_endpoint_external_idx" ON "webhook_events" USING btree ("endpoint_id","external_event_id") WHERE "webhook_events"."external_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_endpoint_hash_idx" ON "webhook_events" USING btree ("endpoint_id","payload_hash") WHERE "webhook_events"."external_event_id" is null;--> statement-breakpoint
CREATE INDEX "webhook_events_org_received_idx" ON "webhook_events" USING btree ("organization_id","received_at");