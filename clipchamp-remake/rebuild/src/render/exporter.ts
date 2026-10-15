// MP4 export: frame-accurate render → WebCodecs VideoEncoder (H.264) + AudioEncoder (AAC/Opus)
// → mp4-muxer. Clipchamp also encodes with WebCodecs `VideoEncoder` (notes.md §2.5); it muxes
// with FFmpeg WASM, we use a small JS muxer.
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { projectDuration, size, type Item, type Project } from "../model";
import { assetUrl, readFile } from "../storage";
import { Compositor, type Source } from "./compositor";

export interface ExportOptions { height?: 480 | 720 | 1080; onProgress?: (fraction: number, stage: string) => void; signal?: AbortSignal }

async function pickVideoCodec(width: number, height: number, bitrate: number, fps: number) {
  for (const codec of ["avc1.640028", "avc1.4d0028", "avc1.42001f"]) {
    const cfg: VideoEncoderConfig = { codec, width, height, bitrate, framerate: fps, avc: { format: "avc" }, bitrateMode: "variable" };
    const s = await VideoEncoder.isConfigSupported(cfg).catch(() => null);
    if (s?.supported) return cfg;
  }
  throw new Error("This browser can't encode H.264 video (WebCodecs).");
}
async function pickAudioCodec(sampleRate: number) {
  for (const [codec, mux] of [["mp4a.40.2", "aac"], ["opus", "opus"]] as const) {
    const cfg: AudioEncoderConfig = { codec, sampleRate, numberOfChannels: 2, bitrate: 160_000 };
    const s = await AudioEncoder.isConfigSupported(cfg).catch(() => null);
    if (s?.supported) return { cfg, mux };
  }
  return null;
}

/** Wait until a video element shows the frame at `time`. */
async function seekExact(v: HTMLVideoElement, time: number) {
  if (Math.abs(v.currentTime - time) < 1e-4 && v.readyState >= 2) return;
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    if ("requestVideoFrameCallback" in v) v.requestVideoFrameCallback(() => done());
    v.addEventListener("seeked", () => setTimeout(done, 0), { once: true });
    v.currentTime = time;
    setTimeout(done, 1500); // never hang the export on one frame
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
    const srcNode = ctx.createBufferSource();
    srcNode.buffer = buf;
    srcNode.playbackRate.value = it.speed;
    const gain = ctx.createGain();
    const end = it.start + it.duration;
    gain.gain.setValueAtTime(it.fadeIn > 0 ? 0 : it.volume, it.start);
    if (it.fadeIn > 0) gain.gain.linearRampToValueAtTime(it.volume, it.start + it.fadeIn);
    if (it.fadeOut > 0) { gain.gain.setValueAtTime(it.volume, end - it.fadeOut); gain.gain.linearRampToValueAtTime(0, end); }
    srcNode.connect(gain).connect(ctx.destination);
    srcNode.start(it.start, it.trimStart, it.duration * it.speed);
    any = true;
  }
  return any ? ctx.startRendering() : null;
}

export async function exportMp4(p: Project, opts: ExportOptions = {}): Promise<Blob> {
  const duration = projectDuration(p);
  if (duration <= 0) throw new Error("The timeline is empty.");
  const [W0, H0] = size(p);
  const scale = (opts.height ?? Math.min(W0, H0)) / Math.min(W0, H0);
  const W = Math.round((W0 * scale) / 2) * 2, H = Math.round((H0 * scale) / 2) * 2;
  const fps = p.fps;
  const frames = Math.ceil(duration * fps);
  const report = opts.onProgress ?? (() => {});

  const videoCfg = await pickVideoCodec(W, H, Math.round(W * H * fps * 0.12), fps);
  const audioPick = await pickAudioCodec(48000);
  report(0, "Mixing audio");
  const audio = audioPick ? await renderAudio(p, duration) : null;

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target, fastStart: "in-memory", firstTimestampBehavior: "offset",
    video: { codec: "avc", width: W, height: H, frameRate: fps },
    ...(audio && audioPick ? { audio: { codec: audioPick.mux, numberOfChannels: 2, sampleRate: 48000 } } : {}),
  });

  let encodeError: Error | null = null;
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encodeError = e; } });
  venc.configure(videoCfg);

  // render with a private canvas + media elements so the preview isn't disturbed
  const canvas = document.createElement("canvas");
  const comp = new Compositor(canvas);
  const exportProject: Project = { ...p };
  const videos = new Map<string, HTMLVideoElement>();
  const images = new Map<string, HTMLImageElement>();
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

  try {
    // the compositor renders at project size; scale the output by drawing into a sized canvas
    const out = document.createElement("canvas");
    out.width = W; out.height = H;
    const g = out.getContext("2d")!;
    for (let f = 0; f < frames; f++) {
      if (opts.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
      if (encodeError) throw encodeError;
      const t = f / fps;
      await Promise.all(p.items.map((it) => {
        const v = videos.get(it.id);
        if (!v) return;
        const last = 1 / fps;
        // transitions show the outgoing clip's last frame / incoming clip's first frame
        const tt = Math.min(Math.max(t, it.start), it.start + it.duration - last);
        const visible = t >= it.start - it.transitionIn.duration && t < it.start + it.duration + 1;
        return visible ? seekExact(v, Math.max(0, it.trimStart + (tt - it.start) * it.speed)) : undefined;
      }));
      comp.render(exportProject, t, (it) => src(it));
      g.drawImage(canvas, 0, 0, W, H);
      const frame = new VideoFrame(out, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / fps) });
      venc.encode(frame, { keyFrame: f % (fps * 2) === 0 });
      frame.close();
      if (venc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
      if (f % 5 === 0) report(f / frames, "Rendering video");
    }
    await venc.flush();

    if (audio && audioPick) {
      report(1, "Encoding audio");
      const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { encodeError = e; } });
      aenc.configure(audioPick.cfg);
      const block = 4800;
      const L = audio.getChannelData(0), R = audio.getChannelData(1);
      for (let i = 0; i < audio.length; i += block) {
        const n = Math.min(block, audio.length - i);
        const planar = new Float32Array(n * 2);
        planar.set(L.subarray(i, i + n), 0);
        planar.set(R.subarray(i, i + n), n);
        const data = new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / 48000) * 1e6), data: planar });
        aenc.encode(data);
        data.close();
      }
      await aenc.flush();
      aenc.close();
    }
    if (encodeError) throw encodeError;
    muxer.finalize();
    report(1, "Done");
    return new Blob([target.buffer], { type: "video/mp4" });
  } finally {
    if (venc.state !== "closed") venc.close();
    for (const v of videos.values()) { v.removeAttribute("src"); v.load(); }
  }
}

