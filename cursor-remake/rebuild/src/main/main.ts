import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as ai from "./ai";
import * as index from "./indexer";
import { fuzzyFiles, grep } from "./search";
import { deletePath, getRoot, isIgnored, listDir, readText, reloadIgnore, resolveInRoot, setRoot, writeText } from "./workspace";

if (process.env.CURSOR_REMAKE_USER_DATA) app.setPath("userData", process.env.CURSOR_REMAKE_USER_DATA);

// ---------------------------------------------------------------- settings
interface Settings { model: string; apiKeyEnc?: string; recent: string[] }
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
function loadSettings(): Settings {
  try { return { model: ai.DEFAULT_MODEL, recent: [], ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) }; }
  catch { return { model: ai.DEFAULT_MODEL, recent: [] }; }
}
let settings = loadSettings();
const saveSettings = () => { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); };
const storedKey = () => {
  if (!settings.apiKeyEnc || !safeStorage.isEncryptionAvailable()) return "";
  try { return safeStorage.decryptString(Buffer.from(settings.apiKeyEnc, "base64")); } catch { return ""; }
};
ai.configure({ apiKey: () => storedKey() || process.env.ANTHROPIC_API_KEY || "", model: () => settings.model || ai.DEFAULT_MODEL });

// ---------------------------------------------------------------- window
let win: BrowserWindow | null = null;
const send = (channel: string, payload: unknown) => win?.webContents.send(channel, payload);

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 800, minHeight: 500,
    backgroundColor: "#1e1e1e", title: "Cursor Remake",
    webPreferences: { preload: path.join(__dirname, "../preload/preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(__dirname, "../renderer/index.html"));
}

// ---------------------------------------------------------------- workspace + watcher
let watcher: fs.FSWatcher | null = null;
let changedBuf = new Set<string>();
let changeTimer: NodeJS.Timeout | undefined;
let indexTimer: NodeJS.Timeout | undefined;

async function openFolder(dir: string) {
  setRoot(dir);
  const root = getRoot()!;
  settings.recent = [root, ...settings.recent.filter((r) => r !== root)].slice(0, 8);
  saveSettings();
  watcher?.close();
  watcher = fs.watch(root, { recursive: true }, (_ev, file) => {
    if (!file) return;
    const rel = file.toString().split(path.sep).join("/");
    if (rel.startsWith(".git/") || rel.includes("node_modules/")) return;
    if (/(^|\/)\.(git|cursor)ignore$/.test(rel)) reloadIgnore();
    if (isIgnored(rel)) return;
    changedBuf.add(rel);
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => { send("fs-changed", [...changedBuf]); changedBuf = new Set(); }, 150);
    clearTimeout(indexTimer);
    indexTimer = setTimeout(() => runIndex(), 2500);
  });
  win?.setTitle(`${path.basename(root)} — Cursor Remake`);
  runIndex();
  return root;
}

let indexing = false;
async function runIndex() {
  if (indexing || !getRoot()) return;
  indexing = true;
  send("index-status", { state: "indexing" });
  try { send("index-status", { state: "ready", ...(await index.reindex()) }); }
  catch (e) { send("index-status", { state: "error", message: (e as Error).message }); }
  finally { indexing = false; }
}

// ---------------------------------------------------------------- terminal panel
const terms = new Map<string, ChildProcess>();
function termRun(id: string, command: string) {
  const root = getRoot();
  if (!root) throw new Error("Open a folder first");
  const shellBin = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];
  const p = spawn(shellBin, args, { cwd: root, env: process.env });
  terms.set(id, p);
  p.stdout?.on("data", (d) => send("term-data", { id, data: d.toString() }));
  p.stderr?.on("data", (d) => send("term-data", { id, data: d.toString() }));
  p.on("error", (e) => send("term-data", { id, data: `\n${e.message}\n` }));
  p.on("close", (code) => { terms.delete(id); send("term-exit", { id, code }); });
}

// ---------------------------------------------------------------- IPC
const completions = new Map<string, AbortController>();
const handle = (ch: string, fn: (...args: any[]) => unknown) =>
  ipcMain.handle(ch, async (_e, ...args) => {
    try { return { ok: true, value: await fn(...args) }; }
    catch (e) { return { ok: false, error: ai.describeError(e) }; }
  });

function registerIpc() {
  handle("folder:pick", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"] });
    return r.canceled ? null : openFolder(r.filePaths[0]);
  });
  handle("folder:open", (dir: string) => openFolder(dir));
  handle("folder:get", () => ({ root: getRoot(), recent: settings.recent }));
  handle("fs:list", (rel: string) => listDir(rel));
  handle("fs:read", (rel: string) => readText(rel));
  handle("fs:write", (rel: string, text: string) => writeText(rel, text));
  handle("fs:delete", (rel: string) => deletePath(rel));
  handle("fs:mkdir", (rel: string) => fs.promises.mkdir(resolveInRoot(rel).abs, { recursive: true }));
  handle("search:files", (q: string) => fuzzyFiles(q, 50));
  handle("search:grep", (pattern: string, opts: { caseSensitive?: boolean; fixed?: boolean; glob?: string }) => grep(pattern, { ...opts, max: 500 }));
  handle("index:run", () => runIndex());
  handle("index:stats", () => index.lastStats);
  handle("index:search", (q: string) => index.search(q, 20));

  handle("ai:chat", (req: ai.ChatRequest) => {
    ai.chat(req, (event) => send("agent-event", { sessionId: req.sessionId, event }));
    return true;
  });
  handle("ai:approve", (sid: string, toolId: string, ok: boolean) => ai.approve(sid, toolId, ok));
  handle("ai:stop", (sid: string) => ai.stop(sid));
  handle("ai:reset", (sid: string) => ai.resetSession(sid));
  handle("ai:pending", (sid: string) => ai.pendingChanges(sid));
  handle("ai:accept", (sid: string, rel: string) => ai.acceptChange(sid, rel));
  handle("ai:reject", (sid: string, rel: string) => ai.rejectChange(sid, rel));
  handle("ai:original", (sid: string, rel: string) => ai.originalOf(sid, rel));
  handle("ai:cmdk", (req: Parameters<typeof ai.cmdK>[0]) => ai.cmdK(req));
  handle("ai:complete", async (id: string, req: Parameters<typeof ai.complete>[0]) => {
    for (const [k, c] of completions) { c.abort(); completions.delete(k); } // only the latest request matters
    const ctl = new AbortController();
    completions.set(id, ctl);
    try { return await ai.complete(req, ctl.signal); }
    catch (e) { if (ctl.signal.aborted) return ""; throw e; }
    finally { completions.delete(id); }
  });

  handle("settings:get", () => ({ model: settings.model, hasKey: !!storedKey(), envKey: !!process.env.ANTHROPIC_API_KEY, canEncrypt: safeStorage.isEncryptionAvailable() }));
  handle("settings:set", (patch: { model?: string; apiKey?: string | null }) => {
    if (patch.model) settings.model = patch.model.trim();
    if (patch.apiKey === null) delete settings.apiKeyEnc;
    else if (patch.apiKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure storage is unavailable on this system; set ANTHROPIC_API_KEY instead.");
      settings.apiKeyEnc = safeStorage.encryptString(patch.apiKey.trim()).toString("base64");
    }
    saveSettings();
    return true;
  });

  handle("term:run", (id: string, command: string) => termRun(id, command));
  handle("term:kill", (id: string) => terms.get(id)?.kill());
}

app.whenReady().then(async () => {
  registerIpc();
  createWindow();
  const initial = process.env.CURSOR_REMAKE_OPEN;
  if (initial) win!.webContents.once("did-finish-load", () => openFolder(initial).then((root) => send("folder-opened", root)));
});
app.on("window-all-closed", () => { for (const p of terms.values()) p.kill(); app.quit(); });
