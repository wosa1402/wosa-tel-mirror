UPDATE "source_channels" SET "mirror_mode" = 'forward' WHERE "mirror_mode" IS NULL;--> statement-breakpoint
ALTER TABLE "source_channels" ALTER COLUMN "mirror_mode" SET NOT NULL;
