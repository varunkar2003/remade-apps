// Storage goes through the native side: media files are copied into the app's data folder
// (with FFmpeg proxies for formats Chromium can't decode), projects are JSON files.
import type { Asset, Project } from "./model";

export interface ExportJob { out: string; width: number; height: number; fps: number; format: "mp4" | "mov" | "webm" | "gif" | "mp3"; encoder?: string; quality: "high" | "medium" | "small"; duration: number }
export interface EncoderInfo { id: string; label: string; codec: "h264" | "hevc"; hardware: boolean }
interface Native {
  pathOf(f: File): string;
  pickMedia(): Promise<string[]>;
  importMedia(p: string): Promise<Asset>;
  removeMedia(id: string): Promise<void>;
  silence(id: string, noiseDb: number, minDur: number): Promise<{ start: number; end: number }[]>;
  analyzeAudio(id: string): Promise<{ waveform: number[]; beats: number[] }>;
  pickLut(): Promise<{ name: string; text: string } | null>;
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  saveProject(p: Project): Promise<void>;
  deleteProject(id: string): Promise<void>;
  encoders(): Promise<EncoderInfo[]>;
  pickExportPath(name: string, ext: string): Promise<string | null>;
  exportStart(job: ExportJob, wav: ArrayBuffer | null): Promise<string>;
  exportFrame(id: string, rgba: ArrayBuffer): Promise<void>;
  exportFinish(id: string): Promise<number>;
  exportCancel(id: string): Promise<void>;
  reveal(file: string): Promise<void>;
  verify(file: string): Promise<{ duration: number; video?: { codec: string; width: number; height: number }; audio?: { codec: string } }>;
  sample(file: string, at: number, x: number, y: number): Promise<number[]>;
  encodeWav(L: Float32Array, R: Float32Array, rate: number): Promise<ArrayBuffer>;
  onImportProgress(fn: (p: { name: string; stage: string; fraction: number }) => void): () => void;
}
export const native = (window as unknown as { native: Native }).native;

export const listProjects = () => native.listProjects();
export const getProject = (id: string) => native.getProject(id);
export const saveProject = (p: Project) => native.saveProject(p);
export async function deleteProject(p: Project) {
  await native.deleteProject(p.id);
  const still = new Set((await native.listProjects()).flatMap((x) => x.assets.map((a) => a.id)));
  for (const a of p.assets) if (!still.has(a.id)) await native.removeMedia(a.id).catch(() => {});
}
export const removeFile = (id: string) => native.removeMedia(id);
export const assetUrl = async (id: string) => `app://media/${id}`;
export const readFile = async (id: string) => new Blob([await (await fetch(`app://media/${id}`)).arrayBuffer()]);

/** Import by path (dialog or dropped/selected File). */
export async function importFile(f: File | string): Promise<Asset> {
  const p = typeof f === "string" ? f : native.pathOf(f);
  if (!p) throw new Error(`${typeof f === "string" ? f : f.name}: can't read this file's location`);
  return native.importMedia(p);
}
