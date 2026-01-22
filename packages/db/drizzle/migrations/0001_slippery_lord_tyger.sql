ALTER TABLE "mirror_channels" ALTER COLUMN "telegram_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mirror_channels" ADD COLUMN "channel_identifier" text;--> statement-breakpoint
UPDATE "mirror_channels"
SET "channel_identifier" = COALESCE(NULLIF("username", ''), NULLIF("invite_link", ''), "name")
WHERE "channel_identifier" IS NULL;--> statement-breakpoint
ALTER TABLE "mirror_channels" ALTER COLUMN "channel_identifier" SET NOT NULL;
