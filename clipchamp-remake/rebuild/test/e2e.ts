// End-to-end in real Chrome (headless): build is served by `vite preview`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright-core";

const PORT = 4173;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.E2E_SHOTS ?? path.join(os.tmpdir(), "clipchamp-remake-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

async function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const srv = spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "preview", "--port", String(PORT), "--strictPort"], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((r) => srv.stdout!.on("data", (d) => String(d).includes(String(PORT)) && r()));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--enable-unsafe-webgpu"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // tsx/esbuild wraps functions in __name(); define it so page.evaluate callbacks run in the browser
  await page.addInitScript("window.__name = (f) => f");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("dialog", (d) => d.accept());

  let failures = 0;
  const shot = (n: string) => page.screenshot({ path: path.join(SHOTS, `${n}.png`) });
  async function step(name: string, fn: () => Promise<unknown>) {
    try { await fn(); console.log(`PASS  ${name}`); }
    catch (e) { failures++; console.log(`FAIL  ${name}\n      ${String((e as Error).message).split("\n").slice(0, 4).join("\n      ")}`); await shot(`fail-${failures}`).catch(() => {}); if (process.env.E2E_STOP) throw e; }
  }
  const clips = () => page.locator(".clip").count();
  /** Average RGB of a region of the preview canvas (fractions of width/height). */
  const previewPixel = (fx: number, fy: number) => page.evaluate(([fx, fy]) => {
    const c = document.querySelector<HTMLCanvasElement>(".preview-canvas")!;
    const t = document.createElement("canvas"); t.width = c.width; t.height = c.height;
    const g = t.getContext("2d")!; g.drawImage(c, 0, 0);
    const d = g.getImageData(Math.floor(c.width * fx) - 4, Math.floor(c.height * fy) - 4, 8, 8).data;
    let r = 0, gg = 0, b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4; return [r / n, gg / n, b / n].map(Math.round);
  }, [fx, fy]);

  try {
    await page.goto(BASE);

    // ---- fixtures generated in the browser: 3s webm (red→green + 440 Hz tone) and a blue PNG
    const fixtures = await page.evaluate(async () => {
      const c = document.createElement("canvas"); c.width = 640; c.height = 360;
      const g = c.getContext("2d")!;
      const ac = new AudioContext(); const osc = ac.createOscillator(); const dest = ac.createMediaStreamDestination();
      osc.frequency.value = 440; osc.connect(dest); osc.start();
      const stream = new MediaStream([...c.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
      const rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8,opus" });
      const chunks: Blob[] = []; rec.ondataavailable = (e) => chunks.push(e.data);
      const t0 = performance.now();
      let raf = 0;
      const paint = () => { const t = (performance.now() - t0) / 1000; g.fillStyle = t < 1.5 ? "#ff0000" : "#00ff00"; g.fillRect(0, 0, 640, 360); raf = requestAnimationFrame(paint); };
      paint(); rec.start(100);
      await new Promise((r) => setTimeout(r, 3000));
      rec.stop(); await new Promise((r) => (rec.onstop = r)); cancelAnimationFrame(raf); osc.stop(); ac.close();
      const vid = new Blob(chunks, { type: "video/webm" });
      const ic = document.createElement("canvas"); ic.width = 400; ic.height = 300;
      const ig = ic.getContext("2d")!; ig.fillStyle = "#0040ff"; ig.fillRect(0, 0, 400, 300); ig.fillStyle = "#fff"; ig.beginPath(); ig.arc(200, 150, 60, 0, 7); ig.fill();
      const img: Blob = await new Promise((r) => ic.toBlob((b) => r(b!), "image/png"));
      const b64 = async (b: Blob) => { const u = new Uint8Array(await b.arrayBuffer()); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
      return { video: await b64(vid), image: await b64(img) };
    });

    await step("home → create a new video opens the editor", async () => {
      await page.getByRole("button", { name: /Create a new video/ }).click();
      await page.getByRole("region", { name: "Timeline" }).waitFor();
    });

    await step("import a WebM (with audio) and a PNG into OPFS", async () => {
      await page.getByLabel("Import media files").setInputFiles([
        { name: "redgreen.webm", mimeType: "video/webm", buffer: Buffer.from(fixtures.video, "base64") },
        { name: "blue.png", mimeType: "image/png", buffer: Buffer.from(fixtures.image, "base64") },
      ]);
      await page.locator(".asset").nth(1).waitFor({ timeout: 20000 });
      const dur = await page.locator(".asset .badge").first().innerText();
      if (!/^0:0[23]/.test(dur)) throw new Error(`video duration badge was ${dur}`);
    });

    await step("add both to the timeline (image lands right after the video)", async () => {
      await page.getByRole("button", { name: "Add redgreen.webm to timeline" }).click();
      await page.getByRole("button", { name: "Add blue.png to timeline" }).click();
      await page.waitForFunction(() => document.querySelectorAll(".clip").length === 2);
      const label = await page.locator(".clip-image").getAttribute("aria-label");
      if (!/at 3\.0 seconds|at 2\.9 seconds/.test(label ?? "")) throw new Error(label ?? "no image clip");
    });

    await step("preview renders the red frame at 0.5s", async () => {
      await page.locator(".ruler").click({ position: { x: 30, y: 10 } }); // 0.5s at 60px/s
      await page.waitForTimeout(600);
      const [r, g, b] = await previewPixel(0.5, 0.5);
      if (!(r > 180 && g < 80 && b < 80)) throw new Error(`pixel ${[r, g, b]}`);
    });

    await step("black & white filter changes the rendered pixels", async () => {
      await page.locator(".clip-video").click();
      await page.getByRole("tab", { name: /Filters/ }).click();
      await page.getByRole("button", { name: "Black & white" }).click();
      await page.waitForTimeout(300);
      const [r, g, b] = await previewPixel(0.5, 0.5);
      if (Math.max(r, g, b) - Math.min(r, g, b) > 12) throw new Error(`not grey: ${[r, g, b]}`);
      await page.keyboard.press("Control+Z");
      await page.waitForTimeout(300);
      const [r2] = await previewPixel(0.5, 0.5);
      if (r2 < 180) throw new Error("undo did not restore colour");
    });

    await step("crossfade transition on the image clip", async () => {
      await page.locator(".clip-image").click();
      await page.getByRole("tab", { name: /Transitions/ }).click();
      await page.getByRole("button", { name: "Crossfade" }).click();
      await page.locator(".clip-image .clip-transition").waitFor();
      // mid-transition (cut at ~3s): green and blue should be blended
      await page.locator(".ruler").click({ position: { x: 3 * 60 + 2, y: 10 } });
      await page.waitForTimeout(700);
      const [, g, b] = await previewPixel(0.2, 0.2);
      if (!(g > 40 && b > 40)) throw new Error(`not blended: g=${g} b=${b}`);
    });

    await step("add a title and edit its text", async () => {
      await page.getByRole("tab", { name: /Text/ }).click();
      await page.getByRole("button", { name: "Title", exact: true }).click();
      await page.locator(".clip-text").waitFor();
      await page.getByLabel("Text content").fill("HELLO E2E");
      await page.locator(".clip-text", { hasText: "HELLO E2E" }).waitFor();
      await shot("01-editor");
    });

    await step("title text is rendered on top (and hide-track removes it)", async () => {
      await page.locator(".ruler").click({ position: { x: 4.5 * 60, y: 10 } });
      await page.waitForTimeout(500);
      const grab = () => page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>(".preview-canvas")!;
        const t = document.createElement("canvas"); t.width = c.width; t.height = c.height;
        const g = t.getContext("2d")!; g.drawImage(c, 0, 0);
        return Array.from(g.getImageData(0, 0, c.width, c.height).data);
      });
      const withText = await grab();
      await page.getByRole("button", { name: "Hide track" }).first().click();
      await page.waitForTimeout(300);
      const without = await grab();
      await page.getByRole("button", { name: "Show track" }).first().click();
      let changed = 0;
      for (let i = 0; i < withText.length; i += 4)
        if (Math.abs(withText[i] - without[i]) + Math.abs(withText[i + 1] - without[i + 1]) + Math.abs(withText[i + 2] - without[i + 2]) > 90) changed++;
      if (changed < 2000) throw new Error(`only ${changed} pixels differ with the text track hidden`);
    });

    await step("split at the playhead with S, undo and redo", async () => {
      await page.locator(".clip-video").click();
      await page.locator(".ruler").click({ position: { x: 60, y: 10 } }); // 1.0s
      const before = await clips();
      await page.keyboard.press("s");
      await page.waitForFunction((n) => document.querySelectorAll(".clip").length === n + 1, before);
      await page.keyboard.press("Control+Z");
      await page.waitForFunction((n) => document.querySelectorAll(".clip").length === n, before);
      await page.keyboard.press("Control+Y");
      await page.waitForFunction((n) => document.querySelectorAll(".clip").length === n + 1, before);
    });

    await step("trim the image clip by dragging its right handle", async () => {
      const clip = page.locator(".clip-image");
      const box = (await clip.boundingBox())!;
      await clip.click();
      await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 63, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
      const after = (await clip.boundingBox())!;
      if (Math.abs(after.width - (box.width - 60)) > 8) throw new Error(`width ${box.width} → ${after.width}`);
    });

    await step("playback advances the clock", async () => {
      await page.keyboard.press("Home");
      await page.getByRole("button", { name: "Play" }).click();
      await page.waitForTimeout(1200);
      await page.getByRole("button", { name: "Pause" }).click();
      const tc = await page.getByLabel("Current time").innerText();
      const secs = Number(tc.split(":")[1]);
      if (!(secs >= 0.8)) throw new Error(`time ${tc}`);
    });

    let exported: { duration: number; width: number; height: number; hasAudio: boolean; endPixel: number[]; startPixel: number[] } | null = null;
    await step("export 480p MP4 with WebCodecs", async () => {
      await page.getByRole("button", { name: "Export" }).click();
      await page.getByRole("radio", { name: /480p/ }).click();
      await page.getByRole("dialog", { name: "Export video" }).getByRole("button", { name: "Export" }).click();
      await page.getByLabel("Exported video").waitFor({ timeout: 120000 });
      await shot("02-exported");
      exported = await page.evaluate(async () => {
        const v = document.querySelector<HTMLVideoElement>("video.result")!;
        const buf = new Uint8Array(await (await fetch(v.src)).arrayBuffer());
        const txt = new TextDecoder("latin1").decode(buf.subarray(0, Math.min(buf.length, 4_000_000)));
        const hasAudio = txt.includes("mp4a") || txt.includes("Opus");
        if (v.readyState < 1) await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
        const sample = async (t: number) => {
          v.currentTime = t; await new Promise((r) => v.addEventListener("seeked", r, { once: true }));
          const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight;
          const g = c.getContext("2d")!; g.drawImage(v, 0, 0);
          // top-centre: inside both the full-frame video and the pillarboxed 4:3 image, outside its white circle
          const d = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height * 0.15), 4, 4).data; return [d[0], d[1], d[2]];
        };
        const startPixel = await sample(0.3);
        const endPixel = await sample(v.duration - 0.2);
        return { duration: v.duration, width: v.videoWidth, height: v.videoHeight, hasAudio, startPixel, endPixel };
      });
      const e = exported!;
      if (e.height !== 480 || e.width !== 854) throw new Error(`size ${e.width}x${e.height}`);
      if (!e.hasAudio) throw new Error("no audio track in MP4");
    });

    await step("exported MP4 has the right duration and content", async () => {
      const e = exported!;
      const expected = await page.evaluate(() => Math.max(...[...document.querySelectorAll(".clip")].map((c) => {
        const m = c.getAttribute("aria-label")!.match(/at ([\d.]+) seconds/); return Number(m?.[1] ?? 0); })));
      if (!(e.duration > 3 && e.duration < 9)) throw new Error(`duration ${e.duration} (last clip starts ${expected})`);
      const [r0, g0, b0] = e.startPixel;
      if (!(r0 > 150 && g0 < 90 && b0 < 90)) throw new Error(`start not red: ${e.startPixel}`);
      const [, g1, b1] = e.endPixel;
      if (!(b1 > 150 && g1 < 120)) throw new Error(`end not blue: ${e.endPixel}`);
      await page.getByRole("button", { name: "Close" }).click();
    });

    await step("project and media persist across a reload", async () => {
      const n = await clips();
      await page.reload();
      await page.getByRole("region", { name: "Timeline" }).waitFor();
      await page.waitForFunction((k) => document.querySelectorAll(".clip").length === k, n, { timeout: 10000 });
      await page.locator(".ruler").click({ position: { x: 30, y: 10 } });
      await page.waitForTimeout(800);
      const [r] = await previewPixel(0.5, 0.5);
      if (r < 150) throw new Error("media not restored from OPFS");
      await page.getByRole("button", { name: "Back to home" }).click();
      await page.getByRole("link", { name: /Open Untitled video/ }).waitFor();
      await shot("03-home");
    });

    await step("no page errors", async () => {
      const real = errors;
      if (real.length) throw new Error(real.slice(0, 3).join(" | "));
    });
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log(failures ? `\n${failures} step(s) failed — screenshots in ${SHOTS}` : `\nall e2e steps passed — screenshots in ${SHOTS}`);
  process.exit(failures ? 1 : 0);
}
main();
