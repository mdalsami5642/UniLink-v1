CREATE INDEX `attempts_course_user_idx` ON `attempts` (`course_code`,`user_id`);
--> statement-breakpoint
CREATE TABLE `resource_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`requester_id` integer NOT NULL,
	`course_code` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`requester_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `resource_requests_status_check` CHECK("resource_requests"."status" in ('open', 'fulfilled', 'closed'))
);
--> statement-breakpoint
CREATE INDEX `resource_requests_feed_idx` ON `resource_requests` (`status`,`expires_at`,`id`);
--> statement-breakpoint
CREATE INDEX `resource_requests_owner_idx` ON `resource_requests` (`requester_id`,`id`);
--> statement-breakpoint
CREATE TABLE `resource_submissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` integer NOT NULL,
	`submitter_id` integer NOT NULL,
	`url` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `resource_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submitter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `resource_submissions_status_check` CHECK("resource_submissions"."status" in ('pending', 'accepted', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resource_submissions_request_user_idx` ON `resource_submissions` (`request_id`,`submitter_id`);
--> statement-breakpoint
CREATE INDEX `resource_submissions_request_status_idx` ON `resource_submissions` (`request_id`,`status`,`id`);
