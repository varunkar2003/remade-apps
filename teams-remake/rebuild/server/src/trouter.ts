// Our stand-in for Teams' "Trouter": a per-user push channel. Real Teams keeps one
// websocket per endpoint to *.trouter.teams.microsoft.com and fans out new-message,
// presence and call events; here each GraphQL `events` subscription is one endpoint.

export interface TrouterEvent {
  kind: string; // newMessage | messageUpdated | typing | presence | threadUpdated | activity | callUpdated | callSignal
  threadId?: string | null;
  messageId?: string | null;
  mri?: string | null;
  payload?: string | null; // JSON for kind-specific data
}

type Sink = { push: (e: TrouterEvent) => void };
const endpoints = new Map<string, Set<Sink>>();
const listeners = new Set<(mri: string, online: boolean) => void>();

export const onConnectionChange = (fn: (mri: string, online: boolean) => void) => listeners.add(fn);
export const isOnline = (mri: string) => (endpoints.get(mri)?.size ?? 0) > 0;
export const onlineMris = () => [...endpoints.keys()].filter(isOnline);

export function publish(mris: Iterable<string>, event: TrouterEvent) {
  for (const mri of new Set(mris)) for (const s of endpoints.get(mri) ?? []) s.push(event);
}

export async function* subscribe(mri: string): AsyncGenerator<TrouterEvent> {
  const queue: TrouterEvent[] = [];
  let wake: (() => void) | null = null;
  const sink: Sink = { push: (e) => { queue.push(e); wake?.(); } };
  let set = endpoints.get(mri);
  if (!set) endpoints.set(mri, (set = new Set()));
  const first = set.size === 0;
  set.add(sink);
  if (first) listeners.forEach((fn) => fn(mri, true));
  try {
    yield { kind: "connected", mri };
    while (true) {
      while (queue.length) yield queue.shift()!;
      await new Promise<void>((r) => (wake = r));
      wake = null;
    }
  } finally {
    set.delete(sink);
    if (set.size === 0) {
      endpoints.delete(mri);
      listeners.forEach((fn) => fn(mri, false));
    }
  }
}
