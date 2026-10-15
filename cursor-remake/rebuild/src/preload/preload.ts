import { contextBridge, ipcRenderer } from "electron";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
async function call<T = any>(ch: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke(ch, ...args)) as Result<T>;
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
const on = (ch: string) => (fn: (payload: any) => void) => {
  const h = (_e: unknown, p: unknown) => fn(p);
  ipcRenderer.on(ch, h);
  return () => { ipcRenderer.removeListener(ch, h); };
};

const api = {
  pickFolder: () => call<string | null>("folder:pick"),
  openFolder: (dir: string) => call<string>("folder:open", dir),
  getFolder: () => call<{ root: string | null; recent: string[] }>("folder:get"),
  list: (rel: string) => call("fs:list", rel),
  read: (rel: string) => call<string>("fs:read", rel),
  write: (rel: string, text: string) => call("fs:write", rel, text),
  remove: (rel: string) => call("fs:delete", rel),
  mkdir: (rel: string) => call("fs:mkdir", rel),
  searchFiles: (q: string) => call<string[]>("search:files", q),
  grep: (pattern: string, opts: object) => call("search:grep", pattern, opts),
  reindex: () => call("index:run"),
  indexStats: () => call("index:stats"),
  chat: (req: object) => call("ai:chat", req),
  approve: (sid: string, toolId: string, ok: boolean) => call("ai:approve", sid, toolId, ok),
  stop: (sid: string) => call("ai:stop", sid),
  resetChat: (sid: string) => call("ai:reset", sid),
  pending: (sid: string) => call<string[]>("ai:pending", sid),
  accept: (sid: string, rel: string) => call("ai:accept", sid, rel),
  reject: (sid: string, rel: string) => call("ai:reject", sid, rel),
  original: (sid: string, rel: string) => call<string | null | undefined>("ai:original", sid, rel),
  cmdK: (req: object) => call<{ replacement: string; original: string }>("ai:cmdk", req),
  complete: (id: string, req: object) => call<string>("ai:complete", id, req),
  getSettings: () => call("settings:get"),
  setSettings: (patch: object) => call("settings:set", patch),
  termRun: (id: string, command: string) => call("term:run", id, command),
  termKill: (id: string) => call("term:kill", id),
  onAgentEvent: on("agent-event"),
  onFsChanged: on("fs-changed"),
  onIndexStatus: on("index-status"),
  onFolderOpened: on("folder-opened"),
  onTermData: on("term-data"),
  onTermExit: on("term-exit"),
};
contextBridge.exposeInMainWorld("api", api);
export type Api = typeof api;
