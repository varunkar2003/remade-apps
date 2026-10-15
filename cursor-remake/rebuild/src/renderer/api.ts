// Typed access to the preload bridge.
export interface Entry { name: string; path: string; dir: boolean }
export interface GrepHit { path: string; line: number; text: string }
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; name: string; input: any }
  | { type: "tool_end"; id: string; ok: boolean; summary: string }
  | { type: "file_changed"; path: string }
  | { type: "approval"; id: string; command: string; explanation?: string }
  | { type: "todos"; todos: { content: string; status: string }[] }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string };
export interface IndexStatus { state: "indexing" | "ready" | "error"; files?: number; chunks?: number; changedFiles?: number; ms?: number; message?: string }
export interface Settings { model: string; hasKey: boolean; envKey: boolean; canEncrypt: boolean }

type Unsub = () => void;
interface Api {
  pickFolder(): Promise<string | null>;
  openFolder(dir: string): Promise<string>;
  getFolder(): Promise<{ root: string | null; recent: string[] }>;
  list(rel: string): Promise<Entry[]>;
  read(rel: string): Promise<string>;
  write(rel: string, text: string): Promise<void>;
  remove(rel: string): Promise<void>;
  mkdir(rel: string): Promise<void>;
  searchFiles(q: string): Promise<string[]>;
  grep(pattern: string, opts: { caseSensitive?: boolean; fixed?: boolean; glob?: string }): Promise<{ hits: GrepHit[]; truncated: boolean }>;
  reindex(): Promise<void>;
  chat(req: { sessionId: string; mode: "agent" | "ask"; text: string; context?: object }): Promise<boolean>;
  approve(sid: string, toolId: string, ok: boolean): Promise<void>;
  stop(sid: string): Promise<void>;
  resetChat(sid: string): Promise<void>;
  pending(sid: string): Promise<string[]>;
  accept(sid: string, rel: string): Promise<void>;
  reject(sid: string, rel: string): Promise<void>;
  original(sid: string, rel: string): Promise<string | null | undefined>;
  cmdK(req: { path: string; language: string; fileText: string; start: number; end: number; instruction: string }): Promise<{ replacement: string; original: string }>;
  complete(id: string, req: { path: string; language: string; prefix: string; suffix: string }): Promise<string>;
  getSettings(): Promise<Settings>;
  setSettings(patch: { model?: string; apiKey?: string | null }): Promise<void>;
  termRun(id: string, command: string): Promise<void>;
  termKill(id: string): Promise<void>;
  onAgentEvent(fn: (p: { sessionId: string; event: AgentEvent }) => void): Unsub;
  onFsChanged(fn: (paths: string[]) => void): Unsub;
  onIndexStatus(fn: (s: IndexStatus) => void): Unsub;
  onFolderOpened(fn: (root: string) => void): Unsub;
  onTermData(fn: (p: { id: string; data: string }) => void): Unsub;
  onTermExit(fn: (p: { id: string; code: number | null }) => void): Unsub;
}
export const api = (window as unknown as { api: Api }).api;
