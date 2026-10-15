// Native media engine on FFmpeg — the role Movavi's FFWrapper / DecodersFF / EncodersFF /
// MuxerFF / AnalyzerSilenceDetector / BeatDetection modules play (notes.md §1).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";

export function ffmpegPath(): string {
  if (process.env.MOVAVI_REMAKE_FFMPEG) return process.env.MOVAVI_REMAKE_FFMPEG;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("ffmpeg-static") as string).replace("app.asar", "app.asar.unpacked");
}

function run(args: string[], opts: { stdout?: boolean; timeoutMs?: number; onStderr?: (s: string) => void } = {}) {
  return new Promise<{ code: number | null; stdout: Buffer; stderr: string }>((resolve, reject) => {
    const p = spawn(ffmpegPath(), ["-hide_banner", "-nostdin", ...args], { windowsHide: true });
    const out: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => { if (opts.stdout) out.push(d); });
    p.stderr.on("data", (d: Buffer) => { const s = d.toString(); err += s; if (err.length > 2_000_000) err = err.slice(-1_000_000); opts.onStderr?.(s); });
    const t = opts.timeoutMs ? setTimeout(() => p.kill(), opts.timeoutMs) : undefined;
    p.on("error", reject);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, stdout: Buffer.concat(out), stderr: err }); });
  });
}

// ---------------------------------------------------------------- probe
export interface Probe {
  duration: number;
  container: string;
  video?: { codec: string; width: number; height: number; fps: number };
  audio?: { codec: string; sampleRate: number; channels: number };
  isImage: boolean;
}

const IMAGE_CODECS = new Set(["png", "mjpeg", "webp", "bmp", "gif", "tiff", "jpegls", "heif", "hevc_image"]);

export async function probe(file: string): Promise<Probe> {
  const { stderr } = await run(["-i", file], { timeoutMs: 30000 });
  const input = stderr.match(/Input #0, ([^,\s]+)/);
  if (!input) throw new Error(stderr.split("\n").filter((l) => /error|invalid/i.test(l)).pop()?.trim() || "Not a media file FFmpeg can read");
  const d = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
  const v = stderr.match(/Stream #\d+:\d+[^:]*: Video: (\w+)[^\n]*?, (\d{2,5})x(\d{2,5})[^\n]*?(?:, ([\d.]+) (?:fps|tbr))?/);
  const a = stderr.match(/Stream #\d+:\d+[^:]*: Audio: (\w+)[^\n]*?, (\d+) Hz, ([^,\n]+)/);
  const video = v ? { codec: v[1], width: Number(v[2]), height: Number(v[3]), fps: Number(v[4] ?? 0) || 30 } : undefined;
  const audio = a ? { codec: a[1], sampleRate: Number(a[2]), channels: /mono/.test(a[3]) ? 1 : /stereo/.test(a[3]) ? 2 : Number(a[3].match(/\d+/)?.[0] ?? 2) } : undefined;
  const isImage = !!video && !audio && (IMAGE_CODECS.has(video.codec) || /image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe/.test(input[1])) && duration < 0.5;
  return { duration, container: input[1], video, audio, isImage };
}

// What Chromium (Electron) can decode directly; everything else gets an H.264 proxy.
const PLAYABLE_VIDEO = new Set(["h264", "vp8", "vp9", "av1", "theora"]);
const PLAYABLE_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le", "pcm_s24le", "pcm_f32le", "pcm_u8"]);
const PLAYABLE_CONTAINERS = /^(mov|mp4|m4a|3gp|3g2|mj2|webm|matroska|ogg|mp3|wav|flac|aac)/;

/** FFmpeg names both MKV and WebM "matroska,webm", so the extension decides between them. */
export function needsProxy(p: Probe, ext: string) {
  if (p.isImage) return false;
  if (/^(mkv|avi|wmv|flv|mpg|mpeg|ts|mts|m2ts|vob|3gp|asf|rm|rmvb)$/i.test(ext)) return true;
  if (!PLAYABLE_CONTAINERS.test(p.container)) return true;
  if (p.video && !PLAYABLE_VIDEO.has(p.video.codec)) return true;
  if (p.audio && !PLAYABLE_AUDIO.has(p.audio.codec)) return true;
  return false;
}

const progressOf = (duration: number, cb?: (f: number) => void) => (s: string) => {
  const m = s.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (m && duration > 0 && cb) cb(Math.min(1, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / duration));
};

/** Transcode to an edit-friendly H.264/AAC MP4 proxy (Movavi transcodes unsupported codecs the same way). */
export async function makeProxy(src: string, dst: string, duration: number, onProgress?: (f: number) => void) {
  const { code, stderr } = await run(["-y", "-i", src, "-map", "0:v:0?", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", dst], { onStderr: progressOf(duration, onProgress) });
  if (code !== 0) throw new Error(`Couldn't convert this file: ${stderr.trim().split("\n").pop()}`);
}

/** JPEG thumbnail as a data URL. */
export async function thumbnail(file: string, at: number, isImage: boolean) {
  const { code, stdout } = await run([...(isImage ? [] : ["-ss", String(Math.max(0, at))]), "-i", file, "-frames:v", "1", "-vf", "scale=240:-2", "-f", "image2", "-c:v", "mjpeg", "-q:v", "5", "pipe:1"], { stdout: true, timeoutMs: 30000 });
  return code === 0 && stdout.length ? `data:image/jpeg;base64,${stdout.toString("base64")}` : undefined;
}

// ---------------------------------------------------------------- audio analysis
const ANALYSIS_RATE = 8000;

/** Decode the first audio stream to mono float PCM. */
export async function decodePcm(file: string): Promise<Float32Array> {
  const { code, stdout } = await run(["-i", file, "-vn", "-ac", "1", "-ar", String(ANALYSIS_RATE), "-f", "f32le", "pipe:1"], { stdout: true, timeoutMs: 300000 });
  if (code !== 0) return new Float32Array(0);
  return new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4));
}

/** Peak amplitude per 1/50 s, 0..1 (timeline waveforms). */
export function waveform(pcm: Float32Array, perSecond = 50) {
  const step = ANALYSIS_RATE / perSecond, out: number[] = [];
  for (let i = 0; i < pcm.length; i += step) {
    let m = 0;
    for (let j = i; j < Math.min(pcm.length, i + step); j++) m = Math.max(m, Math.abs(pcm[j]));
    out.push(Math.round(m * 100) / 100);
  }
  return out;
}

/** Beat times (seconds): spectral-flux-lite onset envelope + adaptive threshold peak picking. */
export function detectBeats(pcm: Float32Array) {
  const hop = 160, win = 320; // 20 ms hop at 8 kHz
  const env: number[] = [];
  let prev = 0;
  for (let i = 0; i + win < pcm.length; i += hop) {
    let e = 0;
    for (let j = i; j < i + win; j++) e += pcm[j] * pcm[j];
    e = Math.sqrt(e / win);
    env.push(Math.max(0, e - prev));
    prev = e;
  }
  const beats: number[] = [];
  const W = 15; // ±300 ms neighbourhood
  let last = -1;
  for (let i = 0; i < env.length; i++) {
    const lo = Math.max(0, i - W), hi = Math.min(env.length, i + W + 1);
    let mean = 0, max = 0;
    for (let j = lo; j < hi; j++) { mean += env[j]; max = Math.max(max, env[j]); }
    mean /= hi - lo;
    if (env[i] === max && env[i] > mean * 1.8 && env[i] > 0.01 && (last < 0 || i - last > 10)) { beats.push((i * hop) / ANALYSIS_RATE); last = i; }
  }
  return beats;
}

/** Silent ranges via FFmpeg silencedetect (Movavi: AnalyzerSilenceDetector). */
export async function detectSilence(file: string, noiseDb = -35, minDur = 0.5) {
  const { stderr } = await run(["-i", file, "-vn", "-af", `silencedetect=noise=${noiseDb}dB:d=${minDur}`, "-f", "null", "-"], { timeoutMs: 300000 });
  const ranges: { start: number; end: number }[] = [];
  let start: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = line.match(/silence_start: (-?[\d.]+)/);
    const e = line.match(/silence_end: ([\d.]+)/);
    if (s) start = Math.max(0, Number(s[1]));
    if (e && start !== null) { ranges.push({ start, end: Number(e[1]) }); start = null; }
  }
  if (start !== null) ranges.push({ start, end: Infinity });
  return ranges;
}

// ---------------------------------------------------------------- encoders + export
export interface EncoderInfo { id: string; label: string; codec: "h264" | "hevc"; hardware: boolean }
const HW_CANDIDATES: EncoderInfo[] = [
  { id: "h264_nvenc", label: "NVIDIA NVENC (H.264)", codec: "h264", hardware: true },
  { id: "hevc_nvenc", label: "NVIDIA NVENC (HEVC)", codec: "hevc", hardware: true },
  { id: "h264_qsv", label: "Intel Quick Sync (H.264)", codec: "h264", hardware: true },
  { id: "h264_amf", label: "AMD AMF (H.264)", codec: "h264", hardware: true },
  { id: "h264_mf", label: "Media Foundation (H.264)", codec: "h264", hardware: true },
  { id: "hevc_mf", label: "Media Foundation (HEVC)", codec: "hevc", hardware: true },
];
let encoderCache: EncoderInfo[] | null = null;

/** Trial-encode two frames with each hardware encoder (Movavi: AccelerationTracker / CodecPolicy). */
export async function detectEncoders(): Promise<EncoderInfo[]> {
  if (encoderCache) return encoderCache;
  const found: EncoderInfo[] = [{ id: "libx264", label: "Software x264 (H.264)", codec: "h264", hardware: false }, { id: "libx265", label: "Software x265 (HEVC)", codec: "hevc", hardware: false }];
  const results = await Promise.all(HW_CANDIDATES.map(async (enc) => {
    const r = await run(["-f", "lavfi", "-i", "color=c=gray:s=320x240:d=0.2:r=10", "-frames:v", "2", "-c:v", enc.id, "-f", "null", "-"], { timeoutMs: 20000 }).catch(() => null);
    return r?.code === 0 ? enc : null;
  }));
  encoderCache = [...results.filter((e): e is EncoderInfo => !!e), ...found];
  return encoderCache;
}

export type ExportFormat = "mp4" | "mov" | "webm" | "gif" | "mp3";
export interface ExportJob { out: string; width: number; height: number; fps: number; format: ExportFormat; encoder?: string; quality: "high" | "medium" | "small"; audioWav?: string; duration: number }

export function exportArgs(j: ExportJob): string[] {
  const q = { high: 0, medium: 1, small: 2 }[j.quality];
  const audioOnly = j.format === "mp3";
  const inputs = audioOnly ? [] : ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${j.width}x${j.height}`, "-r", String(j.fps), "-i", "pipe:0"];
  if (j.audioWav) inputs.push("-i", j.audioWav);
  const aIdx = audioOnly ? 0 : 1;
  const maps = audioOnly ? ["-map", "0:a"] : ["-map", "0:v", ...(j.audioWav ? ["-map", `${aIdx}:a`] : [])];
  let codec: string[];
  switch (j.format) {
    case "mp3": codec = ["-c:a", "libmp3lame", "-q:a", String([0, 2, 5][q])]; break;
    case "gif": codec = ["-vf", `fps=${Math.min(15, j.fps)},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer`, "-loop", "0"]; break;
    case "webm": codec = ["-c:v", "libvpx-vp9", "-crf", String([28, 33, 40][q]), "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", "-pix_fmt", "yuv420p", ...(j.audioWav ? ["-c:a", "libopus", "-b:a", "160k"] : [])]; break;
    case "mov": codec = ["-c:v", "prores_ks", "-profile:v", String([3, 2, 0][q]), "-pix_fmt", "yuv422p10le", ...(j.audioWav ? ["-c:a", "pcm_s16le"] : [])]; break;
    default: {
      const enc = j.encoder ?? "libx264";
      const crf = [18, 22, 27][q];
      const v = enc === "libx264" ? ["-preset", "medium", "-crf", String(crf)]
        : enc === "libx265" ? ["-preset", "medium", "-crf", String(crf + 4), "-tag:v", "hvc1"]
        : enc.endsWith("_nvenc") ? ["-preset", "p5", "-rc", "vbr", "-cq", String(crf + 2), ...(enc.startsWith("hevc") ? ["-tag:v", "hvc1"] : [])]
        : enc.endsWith("_qsv") ? ["-global_quality", String(crf + 3)]
        : enc.endsWith("_amf") ? ["-quality", "balanced", "-rc", "cqp", "-qp_i", String(crf + 2), "-qp_p", String(crf + 4)]
        : ["-b:v", `${Math.round((j.width * j.height * j.fps * [0.15, 0.09, 0.05][q]) / 1000)}k`, ...(enc.startsWith("hevc") ? ["-tag:v", "hvc1"] : [])];
      codec = ["-c:v", enc, ...v, "-pix_fmt", enc.endsWith("_qsv") ? "nv12" : "yuv420p", ...(j.audioWav ? ["-c:a", "aac", "-b:a", "192k"] : []), "-movflags", "+faststart"];
    }
  }
  return ["-y", ...inputs, ...maps, ...codec, "-t", j.duration.toFixed(3), j.out];
}

/** Streaming export: raw RGBA frames in on stdin, encoded file out. */
export class ExportSession {
  private p: ChildProcessWithoutNullStreams;
  private log = "";
  private exited: Promise<number | null>;
  constructor(readonly job: ExportJob) {
    this.p = spawn(ffmpegPath(), ["-hide_banner", "-loglevel", "error", ...exportArgs(job)], { windowsHide: true });
    this.p.stderr.on("data", (d) => { this.log = (this.log + d).slice(-20000); });
    this.p.stdin.on("error", () => {}); // reported via exit code
    this.exited = new Promise((r) => this.p.on("close", r));
  }
  async frame(rgba: Uint8Array) {
    if (this.p.exitCode !== null) throw new Error(`Encoder stopped: ${this.log.trim()}`);
    if (!this.p.stdin.write(rgba)) await new Promise((r) => this.p.stdin.once("drain", r));
  }
  async finish() {
    this.p.stdin.end();
    const code = await this.exited;
    if (code !== 0) throw new Error(`Export failed: ${this.log.trim() || `ffmpeg exit ${code}`}`);
    return fs.statSync(this.job.out).size;
  }
  cancel() { this.p.kill(); }
}

/** Float32 planar stereo → 16-bit PCM WAV. */
export function encodeWav(left: Float32Array, right: Float32Array, sampleRate: number) {
  const n = left.length, buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767))), 46 + i * 4);
  }
  return buf;
}

/** Extract one RGB pixel block from a rendered file (used by tests and "verify export"). */
export async function samplePixel(file: string, at: number, x: number, y: number) {
  const { stdout } = await run(["-ss", String(at), "-i", file, "-frames:v", "1", "-vf", `crop=4:4:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { stdout: true, timeoutMs: 30000 });
  return [stdout[0], stdout[1], stdout[2]];
}

/** Generate a test clip with FFmpeg's lavfi sources (tests + "sample media"). */
export async function generateClip(out: string, spec: { seconds: number; color?: string; second?: string; tone?: number; silenceAt?: [number, number]; size?: string; codec?: string }) {
  const s = spec.size ?? "640x360";
  const half = spec.seconds / 2;
  const v = spec.second
    ? `color=c=${spec.color ?? "red"}:s=${s}:d=${half}:r=30[v0];color=c=${spec.second}:s=${s}:d=${half}:r=30[v1];[v0][v1]concat=n=2:v=1[v]`
    : `color=c=${spec.color ?? "red"}:s=${s}:d=${spec.seconds}:r=30[v]`;
  const vol = spec.silenceAt ? `,volume=enable='between(t,${spec.silenceAt[0]},${spec.silenceAt[1]})':volume=0` : "";
  const a = `sine=f=${spec.tone ?? 440}:d=${spec.seconds}:r=48000${vol}[a]`;
  const { code, stderr } = await run(["-y", "-filter_complex", `${v};${a}`, "-map", "[v]", "-map", "[a]",
    "-c:v", spec.codec ?? "libx264", "-pix_fmt", "yuv420p", "-c:a", spec.codec === "mpeg4" ? "libmp3lame" : "aac", "-shortest", out]);
  if (code !== 0) throw new Error(stderr.slice(-500));
}
