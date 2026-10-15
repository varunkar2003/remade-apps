// Engine tests against the real bundled FFmpeg: probe, proxy, encoder detection,
// silence + beat analysis, waveform, and the streaming export pipe.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as E from "../src/main/engine";

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "movavi-engine-"));
  const f = (n: string) => path.join(dir, n);
  let failures = 0;
  async function check(name: string, fn: () => Promise<unknown>) {
    try { const r = await fn(); if (r === false) throw new Error("returned false"); console.log(`PASS  ${name}`); }
    catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message.split("\n")[0]}`); }
  }

  await E.generateClip(f("a.mp4"), { seconds: 4, color: "red", second: "lime", silenceAt: [1.5, 2.8] });
  await E.generateClip(f("b.avi"), { seconds: 2, color: "blue", codec: "mpeg4" });

  await check("probe reads duration, size, codecs", async () => {
    const p = await E.probe(f("a.mp4"));
    return Math.abs(p.duration - 4) < 0.15 && p.video?.width === 640 && p.video.codec === "h264" && p.audio?.codec === "aac" && !E.needsProxy(p, "mp4");
  });
  await check("unsupported formats are flagged for a proxy", async () => {
    const p = await E.probe(f("b.avi"));
    return p.video?.codec === "mpeg4" && E.needsProxy(p, "avi");
  });
  await check("proxy transcode produces playable H.264/AAC", async () => {
    let last = 0;
    await E.makeProxy(f("b.avi"), f("b.proxy.mp4"), 2, (x) => (last = x));
    const p = await E.probe(f("b.proxy.mp4"));
    return p.video?.codec === "h264" && p.audio?.codec === "aac" && Math.abs(p.duration - 2) < 0.2 && last > 0.5;
  });
  await check("non-media files are rejected with a message", async () => {
    fs.writeFileSync(f("x.mp4"), "not a video");
    try { await E.probe(f("x.mp4")); return false; } catch (e) { return (e as Error).message.length > 0; }
  });
  await check("thumbnail is a JPEG data URL", async () => (await E.thumbnail(f("a.mp4"), 0.5, false))?.startsWith("data:image/jpeg;base64,"));
  await check("silencedetect finds the muted 1.5–2.8 s range", async () => {
    const r = await E.detectSilence(f("a.mp4"));
    return r.length === 1 && Math.abs(r[0].start - 1.5) < 0.1 && Math.abs(r[0].end - 2.8) < 0.1;
  });
  await check("waveform has ~50 peaks/s and shows the silence", async () => {
    const pcm = await E.decodePcm(f("a.mp4"));
    const w = E.waveform(pcm);
    return Math.abs(w.length - 200) < 6 && w[25] > 0.08 && w[110] < 0.01;
  });
  await check("beat detection finds a 120 bpm click track", async () => {
    // 0.5 s spacing clicks
    const sr = 8000, pcm = new Float32Array(sr * 6);
    for (let b = 0.25; b < 6; b += 0.5) for (let i = 0; i < 400; i++) pcm[Math.floor(b * sr) + i] = Math.sin(i * 0.9) * Math.exp(-i / 80);
    const beats = E.detectBeats(pcm);
    const gaps = beats.slice(1).map((t, i) => t - beats[i]);
    return beats.length >= 10 && gaps.every((g) => Math.abs(g - 0.5) < 0.06);
  });
  await check("hardware encoder detection always offers software x264", async () => {
    const enc = await E.detectEncoders();
    console.log(`      encoders: ${enc.map((e) => e.id).join(", ")}`);
    return enc.some((e) => e.id === "libx264");
  });

  const makeFrames = async (job: E.ExportJob) => {
    const s = new E.ExportSession(job);
    const frame = new Uint8Array(job.width * job.height * 4);
    for (let i = 0; i < job.fps * job.duration; i++) {
      for (let p = 0; p < frame.length; p += 4) { frame[p] = 0; frame[p + 1] = 0; frame[p + 2] = 255; frame[p + 3] = 255; }
      await s.frame(frame);
    }
    return s.finish();
  };
  const wav = f("tone.wav");
  {
    const sr = 48000, n = sr * 2, L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) L[i] = R[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / sr);
    fs.writeFileSync(wav, E.encodeWav(L, R, sr));
  }
  await check("streaming export: raw frames + WAV → MP4 (x264/AAC) with the right pixels", async () => {
    await makeFrames({ out: f("out.mp4"), width: 320, height: 180, fps: 30, format: "mp4", encoder: "libx264", quality: "medium", audioWav: wav, duration: 2 });
    const p = await E.probe(f("out.mp4"));
    const px = await E.samplePixel(f("out.mp4"), 1, 100, 80);
    return p.video?.codec === "h264" && p.audio?.codec === "aac" && Math.abs(p.duration - 2) < 0.1 && px[2] > 200 && px[0] < 40;
  });
  for (const [fmt, codec] of [["webm", "vp9"], ["mov", "prores"], ["gif", "gif"]] as const) {
    await check(`export to ${fmt.toUpperCase()} (${codec})`, async () => {
      await makeFrames({ out: f(`out.${fmt}`), width: 320, height: 180, fps: 15, format: fmt, quality: "small", audioWav: fmt === "gif" ? undefined : wav, duration: 1 });
      const p = await E.probe(f(`out.${fmt}`));
      return p.video?.codec === codec;
    });
  }
  await check("export audio only to MP3", async () => {
    const s = new E.ExportSession({ out: f("out.mp3"), width: 0, height: 0, fps: 30, format: "mp3", quality: "medium", audioWav: wav, duration: 2 });
    await s.finish();
    const p = await E.probe(f("out.mp3"));
    return p.audio?.codec === "mp3" && !p.video;
  });
  await check("first available hardware encoder actually encodes", async () => {
    const hw = (await E.detectEncoders()).find((e) => e.hardware && e.codec === "h264");
    if (!hw) { console.log("      (no hardware H.264 encoder on this machine — skipped)"); return true; }
    await makeFrames({ out: f("hw.mp4"), width: 320, height: 180, fps: 30, format: "mp4", encoder: hw.id, quality: "medium", duration: 1 });
    const p = await E.probe(f("hw.mp4"));
    console.log(`      ${hw.id} → ${p.video?.codec} ${p.video?.width}x${p.video?.height}`);
    return p.video?.codec === "h264";
  });

  console.log(failures ? `\n${failures} failed` : "\nall engine checks passed");
  process.exit(failures ? 1 : 0);
}
main();
