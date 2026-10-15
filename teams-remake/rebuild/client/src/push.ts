// Client side of the push channel ("Trouter"). One subscription per app instance;
// events update the Apollo cache and fan out to local listeners (typing, calls).
import { useEffect, useSyncExternalStore } from "react";
import { client } from "./apollo";
import { ACTIVITY, CHATS, EVENTS, MESSAGES, MESSAGE_Q, TEAMS, type Message } from "./gql";

export interface PushEvent {
  kind: string; threadId: string | null; messageId: string | null; mri: string | null; payload: string | null;
  message: Message | null; user: { mri: string } | null; call: any;
}
type Listener = (e: PushEvent) => void;
const listeners = new Set<Listener>();
export const onPush = (fn: Listener) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

// typing indicators: threadId -> mri -> expiry
const typing = new Map<string, Map<string, number>>();
let typingVersion = 0;
const typingSubs = new Set<() => void>();
const bumpTyping = () => { typingVersion++; typingSubs.forEach((f) => f()); };
setInterval(() => {
  const t = Date.now(); let changed = false;
  for (const m of typing.values()) for (const [k, exp] of m) if (exp < t) { m.delete(k); changed = true; }
  if (changed) bumpTyping();
}, 1000);
export function useTyping(threadId: string | null): string[] {
  useSyncExternalStore((f) => { typingSubs.add(f); return () => typingSubs.delete(f); }, () => typingVersion);
  return threadId ? [...(typing.get(threadId)?.keys() ?? [])] : [];
}

let refetchTimer: number | undefined;
const refetchLists = () => {
  clearTimeout(refetchTimer);
  refetchTimer = window.setTimeout(() => client.refetchQueries({ include: [CHATS, TEAMS] }), 150);
};

function handle(e: PushEvent) {
  switch (e.kind) {
    case "newMessage": {
      const m = e.message;
      if (!m) break;
      if (m.parentId) {
        client.query({ query: MESSAGE_Q, variables: { id: m.parentId }, fetchPolicy: "network-only" }).catch(() => {});
      } else {
        client.cache.updateQuery({ query: MESSAGES, variables: { threadId: m.threadId } }, (data: any) =>
          data && !data.messages.some((x: Message) => x.id === m.id) ? { messages: [...data.messages, m] } : data);
      }
      if (m.from) typing.get(m.threadId)?.delete(m.from.mri), bumpTyping();
      refetchLists();
      break;
    }
    case "typing":
      if (e.threadId && e.mri) {
        if (!typing.has(e.threadId)) typing.set(e.threadId, new Map());
        typing.get(e.threadId)!.set(e.mri, Date.now() + 4000);
        bumpTyping();
      }
      break;
    case "threadUpdated":
    case "callUpdated":
      refetchLists();
      break;
    case "activity":
      client.refetchQueries({ include: [ACTIVITY] });
      break;
    // messageUpdated / presence: the selected Message / User is normalized into the cache automatically
  }
  listeners.forEach((fn) => fn(e));
}

export function usePush(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const sub = client.subscribe({ query: EVENTS }).subscribe({
      next: ({ data }) => data && handle(data.events),
      error: (err) => console.warn("push channel error", err),
    });
    return () => sub.unsubscribe();
  }, [enabled]);
}
