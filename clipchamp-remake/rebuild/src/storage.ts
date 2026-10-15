// Local-only storage, like Clipchamp: media files live in the Origin Private File System,
// projects (JSON) in IndexedDB. Nothing is uploaded.
import type { Asset, AssetKind, Project } from "./model";
import { uid } from "./model";

const DB = "clipchamp-remake";
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("projects", { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction("projects", mode);
    const req = fn(t.objectStore("projects"));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
  }));
}
export const listProjects = () => tx<Project[]>("readonly", (s) => s.getAll()).then((ps) => ps.sort((a, b) => b.updatedAt - a.updatedAt));
export const getProject = (id: string) => tx<Project | undefined>("readonly", (s) => s.get(id));
export const saveProject = (p: Project) => tx("readwrite", (s) => s.put({ ...p, updatedAt: Date.now() }));
export async function deleteProject(p: Project) {
  await tx("readwrite", (s) => s.delete(p.id));
  const all = await listProjects();
  const stillUsed = new Set(all.flatMap((x) => x.assets.map((a) => a.id)));
  for (const a of p.assets) if (!stillUsed.has(a.id)) await removeFile(a.id).catch(() => {});
}

// ---------- OPFS ----------
async function mediaDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("media", { create: true });
}
export async function writeFile(id: string, file: Blob) {
  const h = await (await mediaDir()).getFileHandle(id, { create: true });
  const w = await h.createWritable();
  await w.write(file);
  await w.close();
}
export async function readFile(id: string): Promise<File> {
  return (await (await mediaDir()).getFileHandle(id)).getFile();
}
export async function removeFile(id: string) { await (await mediaDir()).removeEntry(id); }

const urls = new Map<string, string>();
/** Object URL for an asset's file (cached for the session). */
export async function assetUrl(id: string) {
  let u = urls.get(id);
  if (!u) { u = URL.createObjectURL(await readFile(id)); urls.set(id, u); }
  return u;
}

// ---------- import + probe ----------
const kindOf = (f: File): AssetKind | null =>
  f.type.startsWith("video/") || /\.(mp4|webm|mov|mkv|m4v)$/i.test(f.name) ? "video"
    : f.type.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(f.name) ? "audio"
    : f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name) ? "image" : null;

function once<T extends Event>(el: EventTarget, ok: string, bad = "error", ms = 15000) {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out waiting for ${ok}`)), ms);
    el.addEventListener(ok, (e) => { clearTimeout(t); resolve(e as T); }, { once: true });
    el.addEventListener(bad, () => { clearTimeout(t); reject(new Error("This file can't be decoded by the browser")); }, { once: true });
  });
}

/** MediaRecorder WebM files report duration=Infinity until you seek past the end. */
async function realDuration(el: HTMLMediaElement) {
  if (Number.isFinite(el.duration) && el.duration > 0) return el.duration;
  el.currentTime = 1e7;
  await once(el, "seeked").catch(() => {});
  const d = el.duration;
  el.currentTime = 0;
  return Number.isFinite(d) ? d : el.currentTime;
}

export async function importFile(file: File): Promise<Asset> {
  const kind = kindOf(file);
  if (!kind) throw new Error(`${file.name}: unsupported file type`);
  const id = uid();
  const url = URL.createObjectURL(file);
  const asset: Asset = { id, name: file.name, kind, mime: file.type, size: file.size, duration: 0, width: 0, height: 0, hasAudio: kind === "audio" };
  try {
    if (kind === "image") {
      const img = new Image();
      img.src = url;
      await img.decode();
      asset.width = img.naturalWidth; asset.height = img.naturalHeight;
      asset.thumb = thumbOf(img, img.naturalWidth, img.naturalHeight);
    } else if (kind === "video") {
      const v = document.createElement("video");
      v.muted = true; v.preload = "auto"; v.src = url;
      await once(v, "loadedmetadata");
      asset.duration = await realDuration(v);
      asset.width = v.videoWidth; asset.height = v.videoHeight;
      asset.hasAudio = await hasAudioTrack(file);
      v.currentTime = Math.min(0.5, asset.duration / 3);
      await once(v, "seeked");
      asset.thumb = thumbOf(v, v.videoWidth, v.videoHeight);
    } else {
      const a = document.createElement("audio");
      a.preload = "metadata"; a.src = url;
      await once(a, "loadedmetadata");
      asset.duration = await realDuration(a);
    }
  } finally { URL.revokeObjectURL(url); }
  if (!(asset.duration > 0) && kind !== "image") throw new Error(`${file.name}: couldn't read the duration`);
  await writeFile(id, file);
  return asset;
}

function thumbOf(src: CanvasImageSource, w: number, h: number) {
  const c = document.createElement("canvas");
  const s = 160 / Math.max(w, h);
  c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.7);
}

/** Decode the file's audio; succeeds only if it has an audio track. */
async function hasAudioTrack(file: Blob) {
  try {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    return buf.duration > 0;
  } catch { return false; }
}
