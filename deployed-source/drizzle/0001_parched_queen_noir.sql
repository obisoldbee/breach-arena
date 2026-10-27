ALTER TABLE `arena_members` ADD `input` text;--> statement-breakpoint
ALTER TABLE `arena_members` ADD `input_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `arena_members` ADD `last_input_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `arena_members` ADD `last_exchange_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `arena_rooms` ADD `snapshot` text;--> statement-breakpoint
ALTER TABLE `arena_rooms` ADD `snapshot_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `arena_rooms` ADD `snapshot_at` integer DEFAULT 0 NOT NULL;