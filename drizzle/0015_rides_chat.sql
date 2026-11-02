CREATE TABLE `rides` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer NOT NULL,
	`kind` text NOT NULL,
	`pickup_label` text NOT NULL,
	`pickup_lat` real NOT NULL,
	`pickup_lon` real NOT NULL,
	`destination_label` text NOT NULL,
	`destination_lat` real NOT NULL,
	`destination_lon` real NOT NULL,
	`vehicle` text NOT NULL,
	`vehicle_brand` text NOT NULL,
	`total_seats` integer NOT NULL,
	`price_per_seat_taka` integer NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`departs_at` integer,
	`recurring_days` text DEFAULT '[]' NOT NULL,
	`departure_time` text,
	`ends_on` text,
	`vehicle_plate` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `rides_kind_check` CHECK("rides"."kind" in ('one_off', 'recurring')),
	CONSTRAINT `rides_status_check` CHECK("rides"."status" in ('open', 'closed', 'completed')),
	CONSTRAINT `rides_seats_check` CHECK("rides"."total_seats" between 1 and 20),
	CONSTRAINT `rides_fare_check` CHECK("rides"."price_per_seat_taka" >= 0),
	CONSTRAINT `rides_pickup_lat_check` CHECK("rides"."pickup_lat" between -90 and 90),
	CONSTRAINT `rides_pickup_lon_check` CHECK("rides"."pickup_lon" between -180 and 180),
	CONSTRAINT `rides_destination_lat_check` CHECK("rides"."destination_lat" between -90 and 90),
	CONSTRAINT `rides_destination_lon_check` CHECK("rides"."destination_lon" between -180 and 180)
);
--> statement-breakpoint
CREATE INDEX `rides_feed_idx` ON `rides` (`status`,`departs_at`,`id`);
--> statement-breakpoint
CREATE INDEX `rides_owner_idx` ON `rides` (`owner_id`,`id`);
--> statement-breakpoint
CREATE TABLE `ride_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ride_id` integer NOT NULL,
	`requester_id` integer NOT NULL,
	`seats` integer NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`ride_id`) REFERENCES `rides`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requester_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `ride_requests_seats_check` CHECK("ride_requests"."seats" between 1 and 20),
	CONSTRAINT `ride_requests_status_check` CHECK("ride_requests"."status" in ('pending', 'accepted', 'declined', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `ride_requests_ride_status_idx` ON `ride_requests` (`ride_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `ride_requests_requester_idx` ON `ride_requests` (`requester_id`,`id`);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`ride_request_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`ride_request_id`) REFERENCES `ride_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `conversations_kind_check` CHECK("conversations"."kind" in ('direct', 'ride'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_ride_request_idx` ON `conversations` (`ride_request_id`);
--> statement-breakpoint
CREATE INDEX `conversations_updated_idx` ON `conversations` (`updated_at`,`id`);
--> statement-breakpoint
CREATE TABLE `conversation_participants` (
	`conversation_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`joined_at` integer NOT NULL,
	`last_read_at` integer,
	PRIMARY KEY(`conversation_id`, `user_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversation_participants_user_idx` ON `conversation_participants` (`user_id`,`conversation_id`);
--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`sender_id` integer NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_messages_conversation_idx` ON `chat_messages` (`conversation_id`,`id`);
