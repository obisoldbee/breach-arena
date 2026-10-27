CREATE TABLE `arena_members` (
	`room_code` text NOT NULL,
	`peer_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`name` text NOT NULL,
	`joined_at` integer NOT NULL,
	`last_seen` integer NOT NULL,
	PRIMARY KEY(`room_code`, `peer_id`)
);
--> statement-breakpoint
CREATE INDEX `arena_members_seen` ON `arena_members` (`room_code`,`last_seen`);--> statement-breakpoint
CREATE TABLE `arena_rooms` (
	`code` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`closed` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `arena_signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`room_code` text NOT NULL,
	`sender` text NOT NULL,
	`recipient` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `arena_signal_recipient` ON `arena_signals` (`room_code`,`recipient`,`id`);--> statement-breakpoint
CREATE INDEX `arena_signal_created` ON `arena_signals` (`created_at`);