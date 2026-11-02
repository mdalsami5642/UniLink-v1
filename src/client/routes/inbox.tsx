import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiGet, apiPost, errorMessage } from "@/lib/api";
import { meQuery } from "@/lib/queries";
import { toast } from "@/lib/toast";

export const Route = createFileRoute("/inbox")({
  beforeLoad: async ({ context }) => { if (!(await context.queryClient.ensureQueryData(meQuery).catch(() => null))) throw redirect({ to: "/login" }); },
  component: ChatInbox,
});

const conversation = z.object({ id:z.number(),kind:z.string(),title:z.string(),otherUserId:z.number(),otherUserName:z.string(),rideId:z.number().nullable(),rideRequestId:z.number().nullable(),rideStatus:z.string().nullable(),archivedAt:z.number().nullable(),unreadCount:z.number(),lastMessage:z.string().nullable(),updatedAt:z.number() });
const conversationList=z.object({items:z.array(conversation)});
const message=z.object({id:z.number(),conversationId:z.number(),senderId:z.number(),senderName:z.string(),body:z.string(),createdAt:z.number()});
const messageList=z.object({items:z.array(message),vehiclePlate:z.string().nullable().optional()});
const sent=message;
const panel="rounded-panel border border-line bg-surface";

/** A conversation list and selected thread; polling provides a simple functional chat without sockets. */
function ChatInbox(){
  const client=useQueryClient();const [selected,setSelected]=useState<number|null>(null);const [body,setBody]=useState("");const me=useQuery(meQuery);
  const list=useQuery({queryKey:["chat","conversations"],queryFn:()=>apiGet("/api/chat/conversations",conversationList),refetchInterval:10000,refetchOnWindowFocus:true});
  const messages=useQuery({queryKey:["chat","messages",selected],queryFn:()=>apiGet(`/api/chat/conversations/${selected}/messages`,messageList),enabled:selected!==null,refetchInterval:5000,refetchOnWindowFocus:true});
  useEffect(()=>{if(selected===null&&list.data?.items[0])setSelected(list.data.items[0].id)},[list.data,selected]);
  const active=list.data?.items.find(x=>x.id===selected);const archived=Boolean(active?.archivedAt);
  const send=useMutation({mutationFn:(text:string)=>apiPost(`/api/chat/conversations/${selected}/messages`,sent,{body:text}),onSuccess:()=>{setBody("");void client.invalidateQueries({queryKey:["chat"]})},onError:(e)=>toast.error(errorMessage(e))});
  function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();if(body.trim())send.mutate(body.trim())}
  const myName=me.data?.username;
  return <div className="space-y-4"><header><h1 className="text-xl font-semibold text-ink">Inbox</h1><p className="text-sm text-soft">Private chats with other students. Ride chats are archived when the driver completes the ride.</p></header>
    <div className={`${panel} grid min-h-[32rem] overflow-hidden md:grid-cols-[18rem_1fr]`}>
      <aside className="border-b border-line md:border-r md:border-b-0"><h2 className="border-b border-line p-3 text-sm font-semibold">Conversations</h2>{list.isPending?<p className="p-4 text-sm text-soft">Loading…</p>:list.data?.items.length?list.data.items.map((c)=><button key={c.id} type="button" onClick={()=>setSelected(c.id)} className={`block w-full border-b border-line p-3 text-left ${selected===c.id?"bg-tint":"hover:bg-tint/50"}`}><span className="flex justify-between gap-2 text-sm font-medium"><span className="truncate">{c.title}</span>{c.unreadCount>0&&<span className="rounded-full bg-brand px-2 text-white">{c.unreadCount}</span>}</span><span className="mt-1 block truncate text-xs text-soft">{c.lastMessage??"No messages yet"}{c.archivedAt?" · Archived":""}</span></button>):<p className="p-4 text-sm text-soft">No chats yet. An accepted ride request starts a private chat.</p>}</aside>
      <section className="flex min-h-[28rem] flex-col"><div className="border-b border-line p-3"><h2 className="font-semibold text-ink">{active?.title??"Choose a conversation"}</h2>{active&&<p className="text-xs text-soft">Chatting with {active.otherUserName}{active.rideStatus?` · Ride ${active.rideStatus}`:""}{archived?" · Archived":""}{messages.data?.vehiclePlate?` · Vehicle plate: ${messages.data.vehiclePlate}`:""}</p>}</div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">{messages.data?.items.map(m=><div key={m.id} className={`max-w-[85%] rounded-panel p-3 text-sm ${m.senderName===myName?"ml-auto bg-brand text-white":"bg-tint text-ink"}`}><p className="mb-1 text-xs opacity-75">{m.senderName===myName?"You":m.senderName} · {new Date(m.createdAt).toLocaleString()}</p><p className="whitespace-pre-wrap break-words">{m.body}</p></div>)}{messages.data?.items.length===0&&<p className="text-center text-sm text-soft">Say hello and coordinate your ride.</p>}</div>
        {active&&<form onSubmit={submit} className="flex gap-2 border-t border-line p-3"><Input aria-label="Message" value={body} maxLength={4000} onChange={e=>setBody(e.target.value)} placeholder={archived?"This chat is archived":"Write a message"} disabled={archived}/><Button disabled={archived||!body.trim()||send.isPending}>Send</Button></form>}
      </section>
    </div>
  </div>;
}
