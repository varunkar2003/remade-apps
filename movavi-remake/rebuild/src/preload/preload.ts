import { contextBridge, ipcRenderer, webUtils } from "electron";

async function call<T = any>(ch: string, ...args: unknown[]): Promise<T> {
  const r = await ipcRenderer.invoke(ch, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value as T;
}
const on = (ch: string) => (fn: (p: any) => void) => {
  const h = (_e: unknown, p: unknown) => fn(p);
  ipcRenderer.on(ch, h);
  return () => { ipcRenderer.removeListener(ch, h); };
};

contextBridge.exposeInMainWorld("native", {
  pathOf: (f: File) => webUtils.getPathForFile(f),
  pickMedia: () => call<string[]>("media:pick"),
  importMedia: (p: string) => call("media:import", p),
  removeMedia: (id: string) => call("media:remove", id),
  silence: (id: string, noiseDb: number, minDur: number) => call("media:silence", id, noiseDb, minDur),
  analyzeAudio: (id: string) => call("media:pcm", id),
  pickLut: () => call("lut:pick"),
  listProjects: () => call("project:list"),
  getProject: (id: string) => call("project:get", id),
  saveProject: (p: object) => call("project:save", p),
  deleteProject: (id: string) => call("project:delete", id),
  encoders: () => call("export:encoders"),
  pickExportPath: (name: string, ext: string) => call<string | null>("export:pickPath", name, ext),
  exportStart: (job: object, wav: ArrayBuffer | null) => call<string>("export:start", job, wav),
  exportFrame: (id: string, rgba: ArrayBuffer) => call("export:frame", id, rgba),
  exportFinish: (id: string) => call<number>("export:finish", id),
  exportCancel: (id: string) => call("export:cancel", id),
  reveal: (file: string) => call("export:reveal", file),
  verify: (file: string) => call("export:verify", file),
  sample: (file: string, at: number, x: number, y: number) => call<number[]>("export:sample", file, at, x, y),
  encodeWav: (L: Float32Array, R: Float32Array, rate: number) => call<ArrayBuffer>("wav:encode", L, R, rate),
  onImportProgress: on("import-progress"),
});
