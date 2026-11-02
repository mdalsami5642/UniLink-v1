import { z } from "zod";
import { id, instant } from "./common";

/** Vehicle categories are deliberately small and map to the filters on the ride board. */
export const vehicleType = z.enum(["bike", "car", "suv", "bus"]);
export const weekday = z.enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
export const rideKind = z.enum(["one_off", "recurring"]);
export const rideStatus = z.enum(["open", "closed", "completed"]);
export const rideRequestStatus = z.enum(["pending", "accepted", "declined", "cancelled"]);

/** A named, map-selected location. Coordinates are WGS84 decimal degrees. */
export const rideLocation = z.strictObject({
  label: z.string().trim().min(2).max(160),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

const rideBase = z.strictObject({
  pickup: rideLocation,
  destination: rideLocation,
  vehicle: vehicleType,
  vehicleBrand: z.string().trim().min(1).max(80),
  totalSeats: z.number().int().min(1).max(20),
  /** Fare is always expressed in Bangladeshi taka per passenger seat. */
  pricePerSeatTaka: z.number().int().min(0).max(1_000_000),
  notes: z.string().trim().max(500).optional(),
});

const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 08:30");
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a valid calendar date");

/** One-off dates are UTC instants; recurring times/days use Dhaka-local calendar values. */
export const rideInput = z.discriminatedUnion("kind", [
  rideBase.extend({ kind: z.literal("one_off"), departsAt: instant }),
  rideBase.extend({
    kind: z.literal("recurring"),
    days: z.array(weekday).min(1).max(7),
    departureTime: localTime,
    endsOn: localDate,
  }),
]);

export const rideFeedQuery = z.object({
  q: z.string().trim().max(120).optional(),
  vehicle: vehicleType.optional(),
  date: localDate.optional(),
  cursor: z.coerce.number().int().positive().optional(),
});

/** Public feed data deliberately excludes owner contact details and the vehicle plate. */
export const rideSummary = z.object({
  id,
  ownerId: id,
  ownerName: z.string(),
  kind: rideKind,
  pickup: rideLocation,
  destination: rideLocation,
  vehicle: vehicleType,
  vehicleBrand: z.string(),
  totalSeats: z.number().int(),
  seatsRemaining: z.number().int(),
  pricePerSeatTaka: z.number().int(),
  notes: z.string(),
  departsAt: instant.nullable(),
  days: z.array(weekday),
  departureTime: z.string().nullable(),
  endsOn: localDate.nullable(),
  status: rideStatus,
  createdAt: instant,
});

export const rideFeed = z.object({ items: z.array(rideSummary), nextCursor: id.nullable() });
export const myRides = z.object({ items: z.array(rideSummary) });

export const rideRequestInput = z.strictObject({
  seats: z.number().int().min(1).max(20),
  message: z.string().trim().max(500).optional(),
});

/** The vehicle plate is collected at acceptance time and returned only inside the accepted chat. */
export const rideDecisionInput = z.strictObject({ vehiclePlate: z.string().trim().min(3).max(20) });

export const rideRequestSummary = z.object({
  id,
  rideId: id,
  requesterId: id,
  requesterName: z.string(),
  seats: z.number().int(),
  message: z.string(),
  status: rideRequestStatus,
  createdAt: instant,
  conversationId: id.nullable(),
});

export const myRide = rideSummary.extend({ requests: z.array(rideRequestSummary) });
export const myRidesDashboard = z.object({ items: z.array(myRide) });

/** A conversation listing is safe for either participant; no messages from other chats are included. */
export const conversationSummary = z.object({
  id,
  kind: z.enum(["direct", "ride"]),
  title: z.string(),
  otherUserId: id,
  otherUserName: z.string(),
  rideId: id.nullable(),
  rideRequestId: id.nullable(),
  rideStatus: rideStatus.nullable(),
  archivedAt: instant.nullable(),
  unreadCount: z.number().int().nonnegative(),
  lastMessage: z.string().nullable(),
  updatedAt: instant,
});

export const conversations = z.object({ items: z.array(conversationSummary) });
export const chatMessageInput = z.strictObject({ body: z.string().trim().min(1).max(4000) });
export const chatMessage = z.object({
  id,
  conversationId: id,
  senderId: id,
  senderName: z.string(),
  body: z.string(),
  createdAt: instant,
});
export const chatMessages = z.object({ items: z.array(chatMessage), nextCursor: id.nullable() });
export const rideOk = z.object({ ok: z.boolean() });

export type RideInput = z.infer<typeof rideInput>;
export type RideSummary = z.infer<typeof rideSummary>;
export type RideRequestSummary = z.infer<typeof rideRequestSummary>;
export type ConversationSummary = z.infer<typeof conversationSummary>;
export type ChatMessage = z.infer<typeof chatMessage>;
