import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import * as E from "./engine";

if (process.env.MOVAVI_REMAKE_USER_DATA) app.setPath("userData", process.env.MOVAVI_REMAKE_USER_DATA);

// One privileged scheme serves the UI and the media, so <video> frames stay same-origin and
// WebGL can read them (file:// would taint the canvas).
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

const dataDir = (...p: string[]) => path.join(app.getPath("userData"), ...p);
const MEDIA = () => dataDir("media");
const PROJECTS = () => dataDir("projects");
const RENDERER = path.join(__dirname, "../renderer");
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".flac": "audio/flac", ".woff2": "font/woff2" };

/** Serve a file with HTTP Range support (needed for <video> seeking). */
function serveFile(file: string, req: Request): Response {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return new Response("Not found", { status: 404 }); }
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    const body = Readable.toWeb(fs.createReadStream(file, { start, end })) as unknown as ReadableStream;
    return new Response(body, { status: 206, headers: { "Content-Type": type, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${st.size}`, "Accept-Ranges": "bytes" } });
  }
  const body = Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream;
  return new Response(body, { headers: { "Content-Type": type, "Content-Length": String(st.size), "Accept-Ranges": "bytes" } });
}

function mediaFile(id: string) {
  if (!/^[a-z0-9]+$/i.test(id)) return null;
  const files = fs.readdirSync(MEDIA()).filter((f) => f.startsWith(`${id}.`));
  return files.find((f) => f.includes(".proxy.")) ?? files[0] ?? null;
}

// ---------------------------------------------------------------- library + projects
interface Imported { id: string; name: string; kind: "video" | "audio" | "image"; mime: string; size: number; duration: number; width: number; height: number; hasAudio: boolean; thumb?: string; proxy: boolean; codec: string; waveform?: number[]; beats?: number[] }
let win: BrowserWindow | null = null;
const send = (ch: string, p: unknown) => win?.webContents.send(ch, p);

async function importPath(src: string): Promise<Imported> {
  const name = path.basename(src);
  const ext = path.extname(src).slice(1).toLowerCase();
  const info = await E.probe(src);
  const id = crypto.randomBytes(8).toString("hex");
  const dst = path.join(MEDIA(), `${id}.${ext || "bin"}`);
  await fs.promises.copyFile(src, dst);
  const kind = info.isImage ? "image" : info.video ? "video" : info.audio ? "audio" : null;
  if (!kind) throw new Error(`${name}: no audio or video streams`);
  let proxy = false;
  if (kind !== "image" && E.needsProxy(info, ext)) {
    send("import-progress", { name, stage: "Converting for editing", fraction: 0 });
    await E.makeProxy(dst, path.join(MEDIA(), `${id}.proxy.mp4`), info.duration, (f) => send("import-progress", { name, stage: "Converting for editing", fraction: f }));
    proxy = true;
  }
  const thumb = kind === "audio" ? undefined : await E.thumbnail(dst, Math.min(1, info.duration / 3), info.isImage);
  let waveform: number[] | undefined, beats: number[] | undefined;
  if (info.audio) {
    const pcm = await E.decodePcm(dst);
    waveform = E.waveform(pcm);
    beats = kind === "audio" ? E.detectBeats(pcm) : undefined;
  }
  return { id, name, kind, mime: MIME[`.${ext}`] ?? "", size: fs.statSync(dst).size, duration: info.isImage ? 0 : info.duration,
    width: info.video?.width ?? 0, height: info.video?.height ?? 0, hasAudio: !!info.audio, thumb, proxy, codec: [info.video?.codec, info.audio?.codec].filter(Boolean).join(" / "), waveform, beats };
}

const projectFile = (id: string) => {
  if (!/^[a-z0-9]+$/i.test(id)) throw new Error("bad project id");
  return path.join(PROJECTS(), `${id}.json`);
};

// ---------------------------------------------------------------- export sessions
const sessions = new Map<string, { s: E.ExportSession; wav?: string }>();

function registerIpc() {
  const handle = (ch: string, fn: (...a: any[]) => unknown) => ipcMain.handle(ch, async (_e, ...a) => {
    try { return { ok: true, value: await fn(...a) }; } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  handle("media:pick", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openFile", "multiSelections"], filters: [{ name: "Media", extensions: ["mp4", "mov", "mkv", "avi", "wmv", "webm", "flv", "mts", "m2ts", "mpg", "3gp", "mp3", "wav", "aac", "m4a", "ogg", "flac", "wma", "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic"] }, { name: "All files", extensions: ["*"] }] });
    return r.canceled ? [] : r.filePaths;
  });
  handle("media:import", (p: string) => importPath(p));
  handle("media:remove", async (id: string) => { for (const f of fs.readdirSync(MEDIA()).filter((x) => x.startsWith(`${id}.`))) await fs.promises.rm(path.join(MEDIA(), f)); });
  handle("media:silence", async (id: string, noiseDb: number, minDur: number) => { const f = mediaFile(id); if (!f) throw new Error("media missing"); return E.detectSilence(path.join(MEDIA(), f), noiseDb, minDur); });
  handle("media:pcm", async (id: string) => { const f = mediaFile(id); if (!f) throw new Error("media missing"); const pcm = await E.decodePcm(path.join(MEDIA(), f)); return { waveform: E.waveform(pcm), beats: E.detectBeats(pcm) }; });
  handle("lut:pick", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openFile"], filters: [{ name: "3D LUT", extensions: ["cube"] }] });
    return r.canceled ? null : { name: path.basename(r.filePaths[0]), text: await fs.promises.readFile(r.filePaths[0], "utf8") };
  });

  handle("project:list", async () => {
    const files = await fs.promises.readdir(PROJECTS());
    const all = await Promise.all(files.filter((f) => f.endsWith(".json")).map(async (f) => { try { return JSON.parse(await fs.promises.readFile(path.join(PROJECTS(), f), "utf8")); } catch { return null; } }));
    return all.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
  });
  handle("project:get", async (id: string) => { try { return JSON.parse(await fs.promises.readFile(projectFile(id), "utf8")); } catch { return null; } });
  handle("project:save", async (p: { id: string }) => {
    const f = projectFile(p.id), tmp = `${f}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify({ ...p, updatedAt: Date.now() }));
    await fs.promises.rename(tmp, f); // atomic replace
  });
  handle("project:delete", async (id: string) => { await fs.promises.rm(projectFile(id), { force: true }); });

  handle("export:encoders", () => E.detectEncoders());
  handle("export:pickPath", async (defName: string, ext: string) => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(app.getPath("videos"), `${defName}.${ext}`), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    return r.canceled ? null : r.filePath;
  });
  handle("export:start", async (job: E.ExportJob, wav: ArrayBuffer | null) => {
    const id = crypto.randomBytes(6).toString("hex");
    let wavPath: string | undefined;
    if (wav) { wavPath = path.join(app.getPath("temp"), `movavi-remake-${id}.wav`); await fs.promises.writeFile(wavPath, Buffer.from(wav)); }
    sessions.set(id, { s: new E.ExportSession({ ...job, audioWav: wavPath }), wav: wavPath });
    return id;
  });
  handle("export:frame", async (id: string, rgba: ArrayBuffer) => sessions.get(id)?.s.frame(new Uint8Array(rgba)));
  handle("export:finish", async (id: string) => {
    const s = sessions.get(id)!;
    try { return await s.s.finish(); } finally { sessions.delete(id); if (s.wav) fs.promises.rm(s.wav, { force: true }); }
  });
  handle("export:cancel", async (id: string) => { const s = sessions.get(id); s?.s.cancel(); sessions.delete(id); if (s?.wav) fs.promises.rm(s.wav, { force: true }); });
  handle("export:reveal", (file: string) => shell.showItemInFolder(file));
  handle("export:verify", async (file: string) => E.probe(file));
  handle("export:sample", async (file: string, at: number, x: number, y: number) => E.samplePixel(file, at, x, y));
  handle("wav:encode", (L: Float32Array, R: Float32Array, rate: number) => {
    const b = E.encodeWav(L, R, rate);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  });
}

app.whenReady().then(() => {
  fs.mkdirSync(MEDIA(), { recursive: true });
  fs.mkdirSync(PROJECTS(), { recursive: true });
  protocol.handle("app", (req) => {
    const u = new URL(req.url);
    if (u.host === "media") {
      const f = mediaFile(decodeURIComponent(u.pathname.slice(1)));
      return f ? serveFile(path.join(MEDIA(), f), req) : new Response("Not found", { status: 404 });
    }
    const rel = decodeURIComponent(u.pathname === "/" ? "/index.html" : u.pathname);
    const file = path.normalize(path.join(RENDERER, rel));
    if (!file.startsWith(RENDERER)) return new Response("Forbidden", { status: 403 });
    return serveFile(file, req);
  });
  registerIpc();
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 640, backgroundColor: "#1b1e23", title: "Movavi Remake",
    webPreferences: { preload: path.join(__dirname, "../preload/preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.loadURL("app://ui/");
});
app.on("window-all-closed", () => { for (const s of sessions.values()) s.s.cancel(); app.quit(); });
