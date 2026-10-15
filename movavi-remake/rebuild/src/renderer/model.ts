// Project model. Movavi's EditorModel is a Composition of tracks/clips with markers,
// per-clip effect chains, Pan & Zoom and a magnetic (gapless) mode (notes.md §1–2).

export type AssetKind = "video" | "audio" | "image";
export interface Asset {
  id: string;
  name: string;
  kind: AssetKind;
  mime: string;
  size: number;
  duration: number; // seconds (images: 0)
  width: number;
  height: number;
  hasAudio: boolean;
  thumb?: string; // small data URL
  proxy?: boolean;     // transcoded for editing
  codec?: string;
  waveform?: number[]; // peaks, 50 per second
  beats?: number[];    // seconds (music)
}

export type EffectType = "chromakey" | "lut" | "vhs" | "glitch" | "vignette" | "tiltshift" | "mosaic" | "invert" | "posterize"
  | "grain" | "chromatic" | "sharpen" | "mirror" | "popart" | "oldfilm" | "edges";
export interface Effect { id: string; type: EffectType; amount: number; color?: string; lut?: { name: string; size: number; data: number[] } }
export interface PanZoom { from: { x: number; y: number; scale: number }; to: { x: number; y: number; scale: number } }

export type ItemKind = "video" | "image" | "audio" | "text";
export type TransitionType = "none" | "crossfade" | "fadeblack" | "wipeleft" | "wiperight" | "wipeup" | "wipedown" | "slideleft" | "slideright" | "zoom" | "circle" | "pixelate"
  | "flash" | "barndoor" | "blinds" | "radial" | "ripple" | "spin" | "dissolve" | "slice";

export interface Filters { brightness: number; contrast: number; saturation: number; hue: number; blur: number; grayscale: number; sepia: number }
export const NO_FILTERS: Filters = { brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0, grayscale: 0, sepia: 0 };

export interface TextStyle { content: string; font: string; size: number; color: string; background: string; bold: boolean; align: "left" | "center" | "right" }

export interface Item {
  id: string;
  kind: ItemKind;
  trackId: string;
  assetId?: string;
  start: number;      // timeline seconds
  duration: number;   // timeline seconds
  trimStart: number;  // seconds into the source
  speed: number;      // playbackRate
  // visual
  x: number; y: number; // centre, 0..1 of frame
  scale: number; rotation: number; opacity: number;
  fit: "contain" | "cover";
  filters: Filters;
  transitionIn: { type: TransitionType; duration: number };
  fadeIn: number; fadeOut: number; // seconds (video/image/text opacity, audio volume)
  // audio
  volume: number; muted: boolean;
  text?: TextStyle;
  effects?: Effect[];
  panZoom?: PanZoom | null;
  reverse?: boolean; // not supported for preview; reserved
}

export interface Track { id: string; kind: "visual" | "audio"; muted: boolean; hidden: boolean }

export type Aspect = "16:9" | "9:16" | "1:1" | "4:5";
export const ASPECTS: Record<Aspect, [number, number]> = { "16:9": [1280, 720], "9:16": [720, 1280], "1:1": [1080, 1080], "4:5": [864, 1080] };

export interface Project {
  id: string;
  name: string;
  aspect: Aspect;
  fps: number;
  background: string;
  tracks: Track[]; // index 0 = top of the stack (drawn last)
  items: Item[];
  assets: Asset[];
  markers?: number[];
  magnetic?: boolean;
  createdAt: number;
  updatedAt: number;
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const size = (p: Project) => ASPECTS[p.aspect];

export function newProject(name = "Untitled video"): Project {
  const now = Date.now();
  return { id: uid(), name, aspect: "16:9", fps: 30, background: "#000000",
    tracks: [{ id: uid(), kind: "visual", muted: false, hidden: false }, { id: uid(), kind: "audio", muted: false, hidden: false }],
    items: [], assets: [], markers: [], magnetic: true, createdAt: now, updatedAt: now };
}

export function projectDuration(p: Project) {
  return p.items.reduce((m, i) => Math.max(m, i.start + i.duration), 0);
}

export function makeItem(kind: ItemKind, trackId: string, start: number, duration: number, extra: Partial<Item> = {}): Item {
  return { id: uid(), kind, trackId, start, duration, trimStart: 0, speed: 1, x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, fit: "contain",
    filters: { ...NO_FILTERS }, transitionIn: { type: "none", duration: 0.5 }, fadeIn: 0, fadeOut: 0, volume: 1, muted: false, ...extra };
}

export const trackKindFor = (k: ItemKind): Track["kind"] => (k === "audio" ? "audio" : "visual");

/** Longest timeline duration an item may have given its source and speed (Infinity for stills/text). */
export function maxDuration(item: Item, asset?: Asset) {
  if (!asset || asset.kind === "image") return Infinity;
  return (asset.duration - item.trimStart) / item.speed;
}

/** Item on a track at time t (tracks never hold overlapping items). */
export const itemAt = (p: Project, trackId: string, t: number) =>
  p.items.find((i) => i.trackId === trackId && t >= i.start && t < i.start + i.duration);

/** Find a free start time on a track at or after `from` for an item of length `dur`. */
export function freeSlot(p: Project, trackId: string, from: number, dur: number, ignore?: string) {
  const others = p.items.filter((i) => i.trackId === trackId && i.id !== ignore).sort((a, b) => a.start - b.start);
  let t = Math.max(0, from);
  for (const o of others) {
    if (t + dur <= o.start + 1e-6) break;
    if (t < o.start + o.duration) t = o.start + o.duration;
  }
  return t;
}

export const fitsAt = (p: Project, trackId: string, start: number, dur: number, ignore?: string) =>
  start >= -1e-6 && !p.items.some((i) => i.trackId === trackId && i.id !== ignore && start < i.start + i.duration - 1e-6 && start + dur > i.start + 1e-6);

/** Split an item at timeline time t; returns the new right-hand item or null. */
export function splitItem(p: Project, id: string, t: number): Project | null {
  const it = p.items.find((i) => i.id === id);
  if (!it || t <= it.start + 0.05 || t >= it.start + it.duration - 0.05) return null;
  const leftDur = t - it.start;
  const left: Item = { ...it, duration: leftDur, fadeOut: 0 };
  const right: Item = { ...it, id: uid(), start: t, duration: it.duration - leftDur, trimStart: it.trimStart + leftDur * it.speed, fadeIn: 0,
    transitionIn: { type: "none", duration: it.transitionIn.duration } };
  return { ...p, items: p.items.map((i) => (i.id === id ? left : i)).concat(right) };
}

/** The item immediately before `it` on its track if they touch (for transitions). */
export function previousAdjacent(p: Project, it: Item) {
  return p.items.find((o) => o.trackId === it.trackId && o.id !== it.id && Math.abs(o.start + o.duration - it.start) < 0.02);
}

/** Magnetic timeline: pull every item on a track left so there are no gaps (Movavi "gapless" mode). */
export function closeGaps(p: Project, trackId: string): Project {
  let t = 0;
  const moved = new Map<string, number>();
  for (const it of p.items.filter((i) => i.trackId === trackId).sort((a, b) => a.start - b.start)) { moved.set(it.id, t); t += it.duration; }
  return { ...p, items: p.items.map((i) => (moved.has(i.id) ? { ...i, start: moved.get(i.id)! } : i)) };
}

/** Remove silent source ranges from a clip, splitting it into the voiced pieces. */
export function removeRanges(p: Project, id: string, silent: { start: number; end: number }[]): Project {
  const it = p.items.find((i) => i.id === id);
  if (!it) return p;
  const srcStart = it.trimStart, srcEnd = it.trimStart + it.duration * it.speed;
  const keep: [number, number][] = [];
  let cur = srcStart;
  for (const r of [...silent].sort((a, b) => a.start - b.start)) {
    const a = Math.max(srcStart, r.start), b = Math.min(srcEnd, r.end);
    if (b <= a) continue;
    if (a - cur > 0.05) keep.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (srcEnd - cur > 0.05) keep.push([cur, srcEnd]);
  if (keep.length === 1 && keep[0][0] === srcStart && keep[0][1] === srcEnd) return p;
  let t = it.start;
  const pieces = keep.map(([a, b], k) => {
    const piece: Item = { ...it, id: k === 0 ? it.id : uid(), start: t, trimStart: a, duration: (b - a) / it.speed, fadeIn: k === 0 ? it.fadeIn : 0, fadeOut: k === keep.length - 1 ? it.fadeOut : 0,
      transitionIn: k === 0 ? it.transitionIn : { type: "none", duration: it.transitionIn.duration } };
    t += piece.duration;
    return piece;
  });
  const removed = it.duration - (t - it.start);
  // shift later items on the same track left by the removed time
  const others = p.items.filter((i) => i.id !== it.id).map((i) => (i.trackId === it.trackId && i.start >= it.start + it.duration - 1e-6 ? { ...i, start: i.start - removed } : i));
  return { ...p, items: [...others, ...pieces] };
}

/** Parse an Adobe/Resolve .cube 3D LUT. */
export function parseCube(name: string, text: string): NonNullable<Effect["lut"]> {
  let size = 0;
  const data: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^LUT_3D_SIZE\s+(\d+)/i);
    if (m) { size = Number(m[1]); continue; }
    if (/^[A-Z_]/i.test(line)) continue; // TITLE, DOMAIN_MIN/MAX...
    const v = line.split(/\s+/).map(Number);
    if (v.length >= 3 && v.every((x) => Number.isFinite(x))) data.push(v[0], v[1], v[2]);
  }
  if (!size || data.length !== size * size * size * 3) throw new Error(`${name}: not a valid 3D .cube LUT`);
  return { name, size, data };
}
