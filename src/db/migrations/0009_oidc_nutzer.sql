ALTER TABLE "decision_participations" ALTER COLUMN "epistemic_status" SET DEFAULT 'HYPOTHESE';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "external_subject" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_login_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "users_external_subject_uq" ON "users" USING btree ("external_subject");