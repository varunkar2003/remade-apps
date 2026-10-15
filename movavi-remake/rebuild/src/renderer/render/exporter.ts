// Export: frames are rendered by the WebGL compositor and streamed as raw RGBA to a native
// FFmpeg process (Movavi: EditorExport → EncodersFF / EncoderNVENC / EncoderQSV / EncoderAMF / MuxerFF).
import { projectDuration, size, type Item, type Project } from "../model";
import { assetUrl, native, readFile, type ExportJob } from "../storage";
import { Compositor, type Source } from "./compositor";

export interface ExportOptions {
  out: string; format: ExportJob["format"]; height: number; encoder?: string; quality: ExportJob["quality"]; fps?: number;
  onProgress?: (fraction: number, stage: string) => void; signal?: AbortSignal;
}

async function seekExact(v: HTMLVideoElement, time: number) {
  if (Math.abs(v.currentTime - time) < 1e-4 && v.readyState >= 2) return;
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    if ("requestVideoFrameCallback" in v) v.requestVideoFrameCallback(() => done());
    v.addEventListener("seeked", () => setTimeout(done, 0), { once: true });
    v.currentTime = time;
    setTimeout(done, 1500);
  });
}

/** Mix every audible item into a stereo buffer with OfflineAudioContext. */
export async function renderAudio(p: Project, duration: number, sampleRate = 48000) {
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * sampleRate)), sampleRate);
  const decoded = new Map<string, AudioBuffer | null>();
  let any = false;
  for (const it of p.items) {
    const a = p.assets.find((x) => x.id === it.assetId);
    const track = p.tracks.find((t) => t.id === it.trackId);
    if (!a || !a.hasAudio || it.muted || track?.muted || it.volume <= 0) continue;
    if (!decoded.has(a.id)) {
      try { decoded.set(a.id, await ctx.decodeAudioData(await (await readFile(a.id)).arrayBuffer())); }
      catch { decoded.set(a.id, null); }
    }
    const buf = decoded.get(a.id);
    if (!buf) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = it.speed;
    const gain = ctx.createGain();
    const end = it.start + it.duration;
    gain.gain.setValueAtTime(it.fadeIn > 0 ? 0 : it.volume, it.start);
    if (it.fadeIn > 0) gain.gain.linearRampToValueAtTime(it.volume, it.start + it.fadeIn);
    if (it.fadeOut > 0) { gain.gain.setValueAtTime(it.volume, end - it.fadeOut); gain.gain.linearRampToValueAtTime(0, end); }
    src.connect(gain).connect(ctx.destination);
    src.start(it.start, it.trimStart, it.duration * it.speed);
    any = true;
  }
  return any ? ctx.startRendering() : null;
}

export async function exportVideo(p: Project, o: ExportOptions): Promise<{ bytes: number; seconds: number }> {
  const t0 = performance.now();
  const duration = projectDuration(p);
  if (duration <= 0) throw new Error("The timeline is empty.");
  const report = o.onProgress ?? (() => {});
  const [W0, H0] = size(p);
  const scale = o.height / Math.min(W0, H0);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const W = o.format === "mp3" ? 0 : even(W0 * scale), H = o.format === "mp3" ? 0 : even(H0 * scale);
  const fps = o.fps ?? p.fps;

  report(0, "Mixing audio");
  const audio = o.format === "gif" ? null : await renderAudio(p, duration);
  const wav = audio ? await native.encodeWav(audio.getChannelData(0), audio.getChannelData(1), audio.sampleRate) : null;
  if (o.format === "mp3" && !wav) throw new Error("There's no audio on the timeline to export.");

  const id = await native.exportStart({ out: o.out, width: W, height: H, fps, format: o.format, encoder: o.encoder, quality: o.quality, duration }, wav);
  if (o.format === "mp3") {
    report(0.9, "Encoding audio");
    const bytes = await native.exportFinish(id);
    return { bytes, seconds: (performance.now() - t0) / 1000 };
  }

  const canvas = document.createElement("canvas");
  const comp = new Compositor(canvas);
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const g = out.getContext("2d", { willReadFrequently: true })!;
  const videos = new Map<string, HTMLVideoElement>();
  const images = new Map<string, HTMLImageElement>();
  try {
    for (const it of p.items) {
      const a = p.assets.find((x) => x.id === it.assetId);
      if (!a) continue;
      if (a.kind === "video") {
        const v = document.createElement("video");
        v.muted = true; v.preload = "auto"; v.src = await assetUrl(a.id);
        await new Promise((r) => { v.addEventListener("loadeddata", r, { once: true }); v.addEventListener("error", r, { once: true }); });
        videos.set(it.id, v);
      } else if (a.kind === "image" && !images.has(a.id)) {
        const img = new Image();
        img.src = await assetUrl(a.id);
        await img.decode().catch(() => {});
        images.set(a.id, img);
      }
    }
    const src = (it: Item): Source | null => {
      const a = p.assets.find((x) => x.id === it.assetId);
      if (a?.kind === "image") { const img = images.get(a.id); return img ? { image: img, width: img.naturalWidth, height: img.naturalHeight } : null; }
      const v = videos.get(it.id);
      return v && v.readyState >= 2 ? { image: v, width: v.videoWidth, height: v.videoHeight } : null;
    };
    const frames = Math.ceil(duration * fps);
    for (let f = 0; f < frames; f++) {
      if (o.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
      const t = f / fps;
      await Promise.all(p.items.map((it) => {
        const v = videos.get(it.id);
        if (!v) return undefined;
        const tt = Math.min(Math.max(t, it.start), it.start + it.duration - 1 / fps);
        const near = t >= it.start - it.transitionIn.duration && t < it.start + it.duration + 1;
        return near ? seekExact(v, Math.max(0, it.trimStart + (tt - it.start) * it.speed)) : undefined;
      }));
      comp.render(p, t, src);
      g.drawImage(canvas, 0, 0, W, H);
      const px = g.getImageData(0, 0, W, H).data;
      await native.exportFrame(id, px.buffer);
      if (f % 5 === 0) report(f / frames, "Rendering and encoding");
    }
    report(1, "Finishing file");
    const bytes = await native.exportFinish(id);
    return { bytes, seconds: (performance.now() - t0) / 1000 };
  } catch (e) {
    await native.exportCancel(id).catch(() => {});
    throw e;
  } finally {
    for (const v of videos.values()) { v.removeAttribute("src"); v.load(); }
  }
}
