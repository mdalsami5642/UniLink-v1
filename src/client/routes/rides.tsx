import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiGet, apiPost, errorMessage } from "@/lib/api";
import { meQuery } from "@/lib/queries";
import { toast } from "@/lib/toast";

export const Route = createFileRoute("/rides")({
  beforeLoad: async ({ context }) => { if (!(await context.queryClient.ensureQueryData(meQuery).catch(() => null))) throw redirect({ to: "/login" }); },
  component: RidesPage,
});

const location = z.object({ label: z.string(), lat: z.number(), lon: z.number() });
const ride = z.object({ id: z.number(), ownerId: z.number(), ownerName: z.string(), kind: z.string(), pickup: location, destination: location, vehicle: z.string(), vehicleBrand: z.string(), totalSeats: z.number(), seatsRemaining: z.number(), pricePerSeatTaka: z.number(), notes: z.string(), departsAt: z.number().nullable(), days: z.array(z.string()), departureTime: z.string().nullable(), endsOn: z.string().nullable(), status: z.string(), createdAt: z.number() });
const feed = z.object({ items: z.array(ride), nextCursor: z.number().nullable() });
const mine = z.object({ items: z.array(ride.extend({ requests: z.array(z.object({ id: z.number(), requesterName: z.string(), seats: z.number(), message: z.string(), status: z.string() })) })) });
const myRequests = z.object({items:z.array(z.object({id:z.number(),status:z.string(),seats:z.number(),message:z.string(),createdAt:z.number(),ride}))});
const ok = z.object({ ok: z.boolean() });
const accepted = z.object({ ok: z.boolean(), conversationId: z.number() });
const requestResult = z.object({ id: z.number(), status: z.string() });
const panel = "rounded-panel border border-line bg-surface p-4";
const geocodeCache = new Map<string, {label:string;lat:number;lon:number}[]>();

/** LocationPicker uses explicit Nominatim search (no keystroke autocomplete) and plots chosen coordinates on OSM. */
function LocationPicker({ title, value, onChange }: { title: string; value: {label:string;lat:number;lon:number}|null; onChange: (v:{label:string;lat:number;lon:number})=>void }) {
  const [query, setQuery] = useState(""); const [results, setResults] = useState<{label:string;lat:number;lon:number}[]>([]); const [busy, setBusy] = useState(false);
  async function search() {
    if (query.trim().length < 3) return;
    setBusy(true);
    try {
      const cacheKey=query.trim().toLocaleLowerCase();
      const cached=geocodeCache.get(cacheKey);
      if(cached){setResults(cached);setBusy(false);return;}
      // Search runs only on submit and is throttled client-side to respect OSM's public service policy.
      const previous = Number(sessionStorage.getItem("unilink:nominatim:last") ?? 0);
      const wait = Math.max(0, 1100 - (Date.now() - previous)); if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      sessionStorage.setItem("unilink:nominatim:last", String(Date.now()));
      const url = new URL("https://nominatim.openstreetmap.org/search"); url.searchParams.set("format", "jsonv2"); url.searchParams.set("limit", "5"); url.searchParams.set("q", query.trim());
      const response = await fetch(url,{cache:"force-cache"}); if (!response.ok) throw new Error("Location search is unavailable.");
      const json = await response.json() as {display_name:string;lat:string;lon:string}[];
      const matches=json.map((x) => ({ label:x.display_name.slice(0,160), lat:Number(x.lat), lon:Number(x.lon) }));
      geocodeCache.set(cacheKey,matches);setResults(matches);
    } catch { toast.error("Could not search locations. Choose another place or try again."); } finally { setBusy(false); }
  }
  return <div className="space-y-2">
    <label className="block text-sm font-medium text-ink">{title}</label>
    <div className="flex gap-2"><Input aria-label={`${title} search`} value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Search a campus, street or landmark"/><Button type="button" variant="outline" disabled={busy} onClick={()=>void search()}>{busy?"Searching":"Search"}</Button></div>
    {results.length>0 && <div className="max-h-36 overflow-y-auto rounded-control border border-line">{results.map((item,i)=><button key={`${item.lat}-${item.lon}-${i}`} type="button" className="block w-full border-b border-line p-2 text-left text-sm hover:bg-tint" onClick={()=>{onChange(item);setResults([]);setQuery(item.label)}}>{item.label}</button>)}</div>}
    {value ? <><p className="text-xs text-soft">Selected: {value.label}</p><iframe title={`${title} on OpenStreetMap`} className="h-40 w-full rounded-control border-0" loading="lazy" src={`https://www.openstreetmap.org/export/embed.html?bbox=${value.lon-.01}%2C${value.lat-.01}%2C${value.lon+.01}%2C${value.lat+.01}&layer=mapnik&marker=${value.lat}%2C${value.lon}`}/></> : <p className="text-xs text-soft">Search and choose a result to set this location. Map data © OpenStreetMap contributors.</p>}
    <a className="text-xs text-brand underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">Map data © OpenStreetMap contributors</a>
  </div>;
}

function RidesPage() {
  const client=useQueryClient(); const [mode,setMode]=useState<"browse"|"mine"|"requests">("browse"); const [showPost,setShowPost]=useState(false); const [search,setSearch]=useState(""); const [vehicle,setVehicle]=useState("");
  const board=useQuery({queryKey:["rides","feed",search,vehicle],queryFn:()=>{const params=new URLSearchParams();if(search)params.set("q",search);if(vehicle)params.set("vehicle",vehicle);return apiGet(`/api/rides${params.size?`?${params}`:""}`,feed)}});
  const own=useQuery({queryKey:["rides","mine"],queryFn:()=>apiGet("/api/rides/mine",mine),enabled:mode==="mine"});
  const mySeatRequests=useQuery({queryKey:["rides","requests","mine"],queryFn:()=>apiGet("/api/rides/requests/mine",myRequests),enabled:mode==="requests"});
  const invalidate=()=>{void client.invalidateQueries({queryKey:["rides"]});void client.invalidateQueries({queryKey:["chat"]});};
  const request=useMutation({mutationFn:({id,seats}:{id:number;seats:number})=>apiPost(`/api/rides/${id}/requests`,requestResult,{seats}),onSuccess:()=>{toast.success("Seat request sent. The driver will notify you when they decide.");invalidate()},onError:(e)=>toast.error(errorMessage(e))});
  const finish=useMutation({mutationFn:(id:number)=>apiPost(`/api/rides/${id}/finish`,ok),onSuccess:()=>{toast.success("Ride marked complete; ride chats are archived.");invalidate()},onError:(e)=>toast.error(errorMessage(e))});
  const create=useMutation({mutationFn:(body:unknown)=>apiPost("/api/rides",ride,body),onSuccess:()=>{setShowPost(false);toast.success("Your ride is now on the board.");invalidate()},onError:(e)=>toast.error(errorMessage(e))});
  return <div className="mx-auto max-w-4xl space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold text-ink">Ride sharing</h1><p className="text-sm text-soft">Find a ride or offer spare seats to other students.</p></div><div className="flex flex-wrap gap-2"><Button variant={mode==="browse"?"default":"outline"} onClick={()=>setMode("browse")}>Browse rides</Button><Button variant={mode==="requests"?"default":"outline"} onClick={()=>setMode("requests")}>My requests</Button><Button variant={mode==="mine"?"default":"outline"} onClick={()=>setMode("mine")}>My rides</Button><Button onClick={()=>setShowPost((v)=>!v)}>＋ Offer a ride</Button></div></header>
    <p className="rounded-control bg-tint p-3 text-sm text-soft">Students arrange rides and payment themselves. Confirm details directly in chat.</p>
    {showPost&&<PostRide onSubmit={(body)=>create.mutate(body)} busy={create.isPending}/>}
    {mode==="browse"&&<div className={`${panel} flex flex-wrap gap-2`}><Input aria-label="Search rides" placeholder="Pickup or destination" value={search} onChange={(e)=>setSearch(e.target.value)}/><select aria-label="Vehicle filter" className="rounded-control border border-line bg-app px-3" value={vehicle} onChange={(e)=>setVehicle(e.target.value)}><option value="">All vehicles</option><option value="bike">Bike</option><option value="car">Car</option><option value="suv">SUV</option><option value="bus">Bus</option></select></div>}
    {mode==="browse"?(board.isPending?<p>Loading rides…</p>:board.data?.items.length?board.data.items.map((r)=><article key={r.id} className={`${panel} space-y-3`}><div className="flex flex-wrap justify-between gap-2"><h2 className="font-semibold text-ink">{r.pickup.label} → {r.destination.label}</h2><span className="rounded-full bg-tint px-2 py-1 text-xs">{r.vehicleBrand} · {r.vehicle}</span></div><p className="text-sm text-soft">{r.kind==="one_off"&&r.departsAt?new Date(r.departsAt).toLocaleString():`${r.days.join(", ")} at ${r.departureTime}`} · {r.seatsRemaining} seats · ৳{r.pricePerSeatTaka} / seat</p>{r.notes&&<p className="text-sm">{r.notes}</p>}<div className="flex justify-end"><Button disabled={request.isPending||r.seatsRemaining===0} onClick={()=>{const raw=prompt(`How many seats? (1–${r.seatsRemaining})`);if(raw){const seats=Number(raw);if(Number.isInteger(seats)&&seats>0&&seats<=r.seatsRemaining)request.mutate({id:r.id,seats});else toast.error("Choose a valid seat count.")}}}>Request seats</Button></div></article>):<p className={panel}>No open rides match this search. Offer one to get started.</p>):mode==="mine"?(own.isPending?<p>Loading your rides…</p>:own.data?.items.length?own.data.items.map((r)=><article key={r.id} className={`${panel} space-y-3`}><h2 className="font-semibold">{r.pickup.label} → {r.destination.label}</h2><p className="text-sm text-soft">{r.requests.length} seat request(s) · {r.seatsRemaining} seats remaining · {r.status}</p>{r.requests.map((x)=><div key={x.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-sm"><span>{x.requesterName} · {x.seats} seat(s) · {x.status}{x.message?` — ${x.message}`:""}</span>{x.status==="pending"&&<RequestActions id={x.id} invalidate={invalidate}/>}</div>)}{r.status!=="completed"&&<Button variant="outline" onClick={()=>finish.mutate(r.id)}>Mark ride finished</Button>}</article>):<p className={panel}>You have not offered a ride yet.</p>):<MySeatRequests query={mySeatRequests.data} loading={mySeatRequests.isPending} invalidate={invalidate}/>}
  </div>;
}

/** The form is intentionally explicit: coordinates come from chosen map search results, never guessed text. */
function PostRide({onSubmit,busy}:{onSubmit:(body:unknown)=>void;busy:boolean}) {
  const [pickup,setPickup]=useState<{label:string;lat:number;lon:number}|null>(null);const [destination,setDestination]=useState<typeof pickup>(null);const [kind,setKind]=useState("one_off");
  function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();const f=new FormData(e.currentTarget);if(!pickup||!destination){toast.error("Choose both locations from the map search results.");return}const common={pickup,destination,vehicle:String(f.get("vehicle")),vehicleBrand:String(f.get("brand")),totalSeats:Number(f.get("seats")),pricePerSeatTaka:Number(f.get("fare")),notes:String(f.get("notes")??"")};
    if(kind==="one_off")onSubmit({...common,kind,departsAt:new Date(String(f.get("departAt"))).getTime()});else onSubmit({...common,kind,days:String(f.get("days")).split(",").map((x)=>x.trim()),departureTime:String(f.get("time")),endsOn:String(f.get("endsOn"))});}
  return <form onSubmit={submit} className={`${panel} grid gap-4 md:grid-cols-2`}><h2 className="md:col-span-2 font-semibold">Offer a ride</h2><LocationPicker title="Pickup" value={pickup} onChange={setPickup}/><LocationPicker title="Destination" value={destination} onChange={setDestination}/><label className="text-sm">Schedule<select name="kind" className="mt-1 block w-full rounded-control border border-line bg-app p-2" value={kind} onChange={(e)=>setKind(e.target.value)}><option value="one_off">One-off</option><option value="recurring">Recurring weekly</option></select></label><label className="text-sm">Vehicle type<select name="vehicle" className="mt-1 block w-full rounded-control border border-line bg-app p-2"><option>car</option><option>bike</option><option>suv</option><option>bus</option></select></label><label className="text-sm">Brand / model<Input required name="brand" placeholder="Toyota Axio"/></label><label className="text-sm">Available seats<Input required name="seats" type="number" min="1" max="20" defaultValue="3"/></label><label className="text-sm">Fair per seat (৳)<Input required name="fare" type="number" min="0" defaultValue="0"/></label>{kind==="one_off"?<label className="text-sm">Departure date and time<Input required name="departAt" type="datetime-local" min={new Date().toISOString().slice(0,16)}/></label>:<><label className="text-sm">Days (sun,mon,tue...)<Input required name="days" placeholder="mon,wed,fri"/></label><label className="text-sm">Departure time<Input required name="time" type="time"/></label><label className="text-sm">Repeat until<Input required name="endsOn" type="date"/></label></>}<label className="text-sm md:col-span-2">Notes<Input name="notes" maxLength={500} placeholder="Optional details"/></label><p className="text-xs text-soft md:col-span-2">Your license plate is requested privately when accepting the first passenger, then shown only in that accepted chat.</p><Button className="md:col-span-2" disabled={busy}>{busy?"Posting…":"Post ride"}</Button></form>;
}

function RequestActions({id,invalidate}:{id:number;invalidate:()=>void}) {const [plate,setPlate]=useState("");const accept=useMutation({mutationFn:()=>apiPost(`/api/rides/requests/${id}/accept`,accepted,{vehiclePlate:plate}),onSuccess:()=>{toast.success("Accepted. A private chat is ready.");invalidate()},onError:(e)=>toast.error(errorMessage(e))});const decline=useMutation({mutationFn:()=>apiPost(`/api/rides/requests/${id}/decline`,ok),onSuccess:invalidate,onError:(e)=>toast.error(errorMessage(e))});return <div className="flex gap-2"><Input aria-label="License plate" placeholder="Plate required to accept" value={plate} onChange={(e)=>setPlate(e.target.value)}/><Button disabled={!plate.trim()||accept.isPending} onClick={()=>accept.mutate()}>Accept</Button><Button variant="outline" onClick={()=>decline.mutate()}>Decline</Button></div>}

function MySeatRequests({query,loading,invalidate}:{query:z.infer<typeof myRequests>|undefined;loading:boolean;invalidate:()=>void}){const cancel=useMutation({mutationFn:(id:number)=>apiPost(`/api/rides/requests/${id}/cancel`,ok),onSuccess:()=>{invalidate();toast.success("Seat request cancelled.")},onError:(e)=>toast.error(errorMessage(e))});if(loading)return <p>Loading your requests…</p>;if(!query?.items.length)return <p className={panel}>You have not requested seats from a ride yet.</p>;return <div className="space-y-3">{query.items.map((item)=><article key={item.id} className={`${panel} space-y-2`}><h2 className="font-semibold">{item.ride.pickup.label} → {item.ride.destination.label}</h2><p className="text-sm text-soft">Driver: {item.ride.ownerName} · {item.seats} seat(s) · ৳{item.ride.pricePerSeatTaka} per seat · {item.status}</p>{item.message&&<p className="text-sm">Your message: {item.message}</p>}<div className="flex gap-2">{item.status==="accepted"&&<Link to="/inbox" className="rounded-control bg-brand px-3 py-2 text-sm font-medium text-white">Open ride chat</Link>}{["pending","accepted"].includes(item.status)&&<Button variant="outline" disabled={cancel.isPending} onClick={()=>cancel.mutate(item.id)}>Cancel request</Button>}</div></article>)}</div>}
