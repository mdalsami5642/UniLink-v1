import { Hono, type Context } from "hono";
import type { z } from "zod";
import { rideInput, rideFeedQuery, rideRequestInput, rideDecisionInput, rideOk, type RideSummary } from "../../../shared/schemas/rides";
import { pushSenderFromEnv } from "../../adapters/push";
import { getDb } from "../../db/client";
import { users } from "../../db/schema";
import { requireUser } from "../../middleware/auth";
import type { AppEnv } from "../../middleware/types";
import { notify } from "../../notify";
import { ridesRepo } from "../../repos/rides";
import { validateJson, validateQuery } from "../../validate";

const uid = (c: Context<AppEnv>) => c.get("user")?.id ?? 0;
const missing = (c: Context) => c.json({ error: "not_found" }, 404);
const stateError = (c: Context, message: string) => c.json({ error: "invalid_state", message }, 409);
const paramId = (c: Context) => { const n = Number(c.req.param("id")); return Number.isSafeInteger(n) && n > 0 ? n : null; };

/** Public feed serializer: the private plate is intentionally omitted from every ride card. */
function summary(row: any, seatsTaken = 0): RideSummary {
  const r = row.ride;
  return {
    id: r.id, ownerId: r.ownerId, ownerName: row.ownerName, kind: r.kind,
    pickup: { label: r.pickupLabel, lat: r.pickupLat, lon: r.pickupLon },
    destination: { label: r.destinationLabel, lat: r.destinationLat, lon: r.destinationLon },
    vehicle: r.vehicle, vehicleBrand: r.vehicleBrand, totalSeats: r.totalSeats,
    seatsRemaining: Math.max(0, r.totalSeats - seatsTaken), pricePerSeatTaka: r.pricePerSeatTaka,
    notes: r.notes, departsAt: r.departsAt, days: r.recurringDays ?? [], departureTime: r.departureTime,
    endsOn: r.endsOn, status: r.status, createdAt: r.createdAt,
  };
}

/** Ride API owns authentication, authorization, and recipient selection; repositories own SQL. */
export const rideRoutes = new Hono<AppEnv>().use(requireUser)
  .get("/", validateQuery(rideFeedQuery), async (c) => {
    const q = c.req.valid("query");
    const rows = await ridesRepo(getDb(c.env.DB)).listOpen(q.q, q.vehicle, Date.now());
    const items = rows.filter(({ ride }) => {
      if (ride.kind !== "recurring" || !q.date) return true;
      const day = new Date(`${q.date}T12:00:00+06:00`).getDay();
      return (ride.days ?? []).includes((["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const)[day]) && (!ride.endsOn || ride.endsOn >= q.date);
    }).map((row) => summary(row, row.seatsTaken));
    return c.json({ items, nextCursor: null });
  })
  .get("/mine", async (c) => {
    const repo = ridesRepo(getDb(c.env.DB));
    const rows = await repo.listMine(uid(c));
    const items = [];
    for (const row of rows) {
      const requests = await repo.requestsForRide(row.ride.id);
      const requestItems = [];
      for (const x of requests) requestItems.push({
        id: x.request.id, rideId: x.request.rideId, requesterId: x.request.requesterId,
        requesterName: x.requesterName, seats: x.request.seats, message: x.request.message,
        status: x.request.status, createdAt: x.request.createdAt,
        conversationId: x.request.status === "accepted" ? await repo.conversationIdForRequest(x.request.id) : null,
      });
      items.push({ ...summary(row, row.seatsTaken), requests: requestItems });
    }
    return c.json({ items });
  })
  .get("/requests/mine", async (c) => {
    const rows = await ridesRepo(getDb(c.env.DB)).listRequestsByPassenger(uid(c));
    return c.json({ items: rows.map((row) => ({
      id: row.request.id, status: row.request.status, seats: row.request.seats,
      message: row.request.message, createdAt: row.request.createdAt,
      ride: summary({ ride: row.ride, ownerName: row.ownerName }),
    })) });
  })
  .post("/", validateJson(rideInput), async (c) => {
    const body = c.req.valid("json");
    const now = Date.now();
    if (body.kind === "one_off" && body.departsAt <= now) return c.json({ error: "invalid_request", message: "Departure must be in the future." }, 400);
    if (body.kind === "recurring" && body.endsOn < new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" })) return c.json({ error: "invalid_request", message: "Choose an end date in the future." }, 400);
    const row = await ridesRepo(getDb(c.env.DB)).createRide({
      ownerId: uid(c), kind: body.kind, pickupLabel: body.pickup.label, pickupLat: body.pickup.lat,
      pickupLon: body.pickup.lon, destinationLabel: body.destination.label, destinationLat: body.destination.lat,
      destinationLon: body.destination.lon, vehicle: body.vehicle, vehicleBrand: body.vehicleBrand,
      totalSeats: body.totalSeats, pricePerSeatTaka: body.pricePerSeatTaka, notes: body.notes ?? "",
      departsAt: body.kind === "one_off" ? body.departsAt : null,
      recurringDays: body.kind === "recurring" ? body.days : [],
      departureTime: body.kind === "recurring" ? body.departureTime : null,
      endsOn: body.kind === "recurring" ? body.endsOn : null,
      status: "open", createdAt: now, updatedAt: now,
    });
    const user = c.get("user")!;
    return c.json(summary({ ride: row, ownerName: user.username }), 201);
  })
  .post("/:id/requests", validateJson(rideRequestInput), async (c) => {
    const id = paramId(c); if (!id) return missing(c);
    const db = getDb(c.env.DB); const repo = ridesRepo(db); const ride = await repo.findRide(id);
    if (!ride || ride.ride.status !== "open") return missing(c);
    if (ride.ride.ownerId === uid(c)) return c.json({ error: "own_ride" }, 400);
    const active = await repo.findActiveRequest(id, uid(c)); if (active) return stateError(c, "You already have an active request for this ride.");
    const taken = (await repo.listMine(ride.ride.ownerId)).find((r) => r.ride.id === id)?.seatsTaken ?? 0;
    const body = c.req.valid("json");
    if (body.seats > ride.ride.totalSeats - taken) return stateError(c, "There are not enough seats remaining.");
    const now = Date.now();
    const request = await repo.createRequest({ rideId: id, requesterId: uid(c), seats: body.seats, message: body.message ?? "", status: "pending", createdAt: now, decidedAt: null });
    await notify(db, [ride.ride.ownerId], "ride_request_received", { rideId: id }, { now, push: pushSenderFromEnv(c.env) });
    return c.json({ id: request.id, status: request.status }, 201);
  })
  .post("/requests/:id/accept", validateJson(rideDecisionInput), async (c) => {
    const id = paramId(c); if (!id) return missing(c);
    const db = getDb(c.env.DB); const repo = ridesRepo(db); const request = await repo.findRequest(id);
    if (!request) return missing(c);
    const ride = await repo.findRide(request.rideId);
    if (!ride || ride.ride.ownerId !== uid(c)) return missing(c);
    const plate = c.req.valid("json").vehiclePlate;
    if (!(await repo.reservePlate(ride.ride.id, plate, Date.now()))) return stateError(c, "This ride is no longer accepting requests.");
    const now = Date.now(); const accepted = await repo.acceptRequest(id, now);
    if (!accepted) return stateError(c, "The request is no longer pending or there are not enough seats.");
    const conversation = await repo.createRideConversation(accepted, uid(c), now);
    await notify(db, [accepted.requesterId], "ride_request_decision", { rideId: ride.ride.id }, { now, push: pushSenderFromEnv(c.env) });
    return c.json({ ok: true, conversationId: conversation.id } satisfies z.infer<typeof rideOk> & { conversationId: number });
  })
  .post("/requests/:id/decline", async (c) => {
    const id = paramId(c); if (!id) return missing(c);
    const repo = ridesRepo(getDb(c.env.DB)); const request = await repo.findRequest(id);
    if (!request) return missing(c); const ride = await repo.findRide(request.rideId);
    if (!ride || ride.ride.ownerId !== uid(c)) return missing(c);
    const now = Date.now(); const changed = await repo.declineRequest(id, now);
    if (!changed) return stateError(c, "This request has already been decided.");
    await notify(getDb(c.env.DB), [changed.requesterId], "ride_request_declined", { rideId: ride.ride.id }, { now, push: pushSenderFromEnv(c.env) });
    return c.json({ ok: true });
  })
  .post("/requests/:id/cancel", async (c) => {
    const id = paramId(c); if (!id) return missing(c);
    const row = await ridesRepo(getDb(c.env.DB)).cancelRequest(id, uid(c), Date.now());
    return row ? c.json({ ok: true }) : missing(c);
  })
  .post("/:id/finish", async (c) => {
    const id = paramId(c); if (!id) return missing(c);
    const ok = await ridesRepo(getDb(c.env.DB)).finishRide(id, uid(c), Date.now());
    return ok ? c.json({ ok: true }) : missing(c);
  })
  .post("/:id/close", async (c) => {
    const id = paramId(c); if (!id) return missing(c);
    const repo = ridesRepo(getDb(c.env.DB)); const ride = await repo.findRide(id);
    if (!ride || ride.ride.ownerId !== uid(c)) return missing(c);
    if (ride.ride.status !== "open") return stateError(c, "This ride is already closed.");
    await repo.updateRide(id, { status: "closed", updatedAt: Date.now() });
    return c.json({ ok: true });
  });
