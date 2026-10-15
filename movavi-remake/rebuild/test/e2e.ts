// End-to-end: real Electron app + real FFmpeg. Fixtures are generated with the bundled FFmpeg.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import * as E from "../src/main/engine";

const SHOTS = process.env.E2E_SHOTS ?? path.join(os.tmpdir(), "movavi-remake-shots");
fs.mkdirSync(SHOTS, { recursive: true });

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "movavi-e2e-"));
  const f = (n: string) => path.join(dir, n);
  await E.generateClip(f("talk.mp4"), { seconds: 6, color: "red", second: "lime", silenceAt: [2, 3.5] });
  await E.generateClip(f("old.avi"), { seconds: 3, color: "blue", codec: "mpeg4" });
  { // 120 bpm click track
    const sr = 48000, n = sr * 4, L = new Float32Array(n);
    for (let b = 0.25; b < 4; b += 0.5) for (let i = 0; i < 2000; i++) L[Math.floor(b * sr) + i] = 0.8 * Math.sin(i * 0.3) * Math.exp(-i / 400);
    fs.writeFileSync(f("beats.wav"), E.encodeWav(L, L, sr));
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "movavi-ud-"));
  const launch = () => electron.launch({ args: ["."], cwd: path.resolve(__dirname, ".."), env: { ...process.env, MOVAVI_REMAKE_USER_DATA: userData } });

  let app: ElectronApplication = await launch();
  let page: Page = await app.firstWindow();
  const errors: string[] = [];
  const watch = (p: Page) => { p.on("pageerror", (e) => errors.push(e.message)); p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); }); };
  watch(page);
  await page.addInitScript("window.__name = (f) => f");
  await page.evaluate("window.__name = (f) => f");

  let failures = 0;
  const shot = (n: string) => page.screenshot({ path: path.join(SHOTS, `${n}.png`) });
  async function step(name: string, fn: () => Promise<unknown>) {
    try { await fn(); console.log(`PASS  ${name}`); }
    catch (e) { failures++; console.log(`FAIL  ${name}\n      ${String((e as Error).message).split("\n").slice(0, 4).join("\n      ")}`); await shot(`fail-${failures}`).catch(() => {}); if (process.env.E2E_STOP) throw e; }
  }
  const pixel = (fx: number, fy: number) => page.evaluate(([fx, fy]) => {
    const c = document.querySelector<HTMLCanvasElement>(".preview-canvas")!;
    const t = document.createElement("canvas"); t.width = c.width; t.height = c.height;
    const g = t.getContext("2d")!; g.drawImage(c, 0, 0);
    const d = g.getImageData(Math.floor(c.width * fx) - 3, Math.floor(c.height * fy) - 3, 6, 6).data;
    let r = 0, gg = 0, b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4; return [r / n, gg / n, b / n].map(Math.round);
  }, [fx, fy]);
  const seekTo = async (sec: number) => {
    const ruler = page.locator(".ruler");
    await ruler.click({ position: { x: Math.max(1, sec * 60), y: 10 } });
    await page.waitForTimeout(500);
  };
  const clipStart = async (sel: string) => Number((await page.locator(sel).first().getAttribute("aria-label"))!.match(/at ([\d.]+) seconds/)![1]);

  try {
    await step("start screen → new project", async () => {
      await page.getByRole("button", { name: /New project/ }).click({ timeout: 20000 });
      await page.getByRole("region", { name: "Timeline" }).waitFor();
    });

    await step("import MP4 + AVI (proxied by FFmpeg) + WAV", async () => {
      await page.getByLabel("Import media files").setInputFiles([f("talk.mp4"), f("old.avi"), f("beats.wav")]);
      await page.locator(".asset").nth(2).waitFor({ timeout: 60000 });
      if ((await page.locator(".proxy-badge").count()) !== 1) throw new Error("expected exactly one proxied asset (the AVI)");
    });

    await step("add both videos to the timeline back to back", async () => {
      await page.getByRole("button", { name: "Add talk.mp4 to timeline" }).click();
      await page.getByRole("button", { name: "Add old.avi to timeline" }).click();
      await page.waitForFunction(() => document.querySelectorAll(".clip-video").length === 2);
      const s = await page.locator(".clip-video").nth(1).getAttribute("aria-label");
      if (!/at (5\.9|6\.0)/.test(s ?? "")) throw new Error(s ?? "");
    });

    await step("preview shows the red frame; proxied AVI renders blue", async () => {
      await seekTo(0.5);
      const [r, g] = await pixel(0.5, 0.5);
      if (!(r > 180 && g < 80)) throw new Error(`0.5s: ${[r, g]}`);
      await seekTo(7.5);
      const [, , b] = await pixel(0.5, 0.5);
      if (b < 180) throw new Error(`7.5s blue=${b}`);
    });

    await step("GPU effect: Invert turns red into cyan", async () => {
      await page.locator(".clip-video").first().click();
      await page.getByRole("tab", { name: /Effects/ }).click();
      await page.getByRole("button", { name: "Invert" }).click();
      await seekTo(0.5);
      const [r, g, b] = await pixel(0.5, 0.5);
      if (!(r < 60 && g > 190 && b > 190)) throw new Error(`inverted: ${[r, g, b]}`);
      await page.keyboard.press("Control+Z");
    });

    await step("chroma key removes the keyed colour (lime → background)", async () => {
      await page.locator(".clip-video").first().click();
      await page.getByRole("tab", { name: /Effects/ }).click();
      await page.getByRole("button", { name: "Chroma key" }).click();
      await page.getByRole("tab", { name: /Clip properties/ }).click();
      await page.getByLabel("Key colour").evaluate((el: HTMLInputElement) => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        set.call(el, "#00ff00"); el.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await seekTo(4.5);
      const [r, g, b] = await pixel(0.5, 0.5);
      if (!(g < 60 && r < 60 && b < 60)) throw new Error(`lime not keyed: ${[r, g, b]}`);
      await page.getByRole("button", { name: "Remove chromakey" }).click();
    });

    await step("Pan & Zoom on the second clip", async () => {
      await page.locator(".clip-video").nth(1).click();
      await page.getByRole("tab", { name: /Tools/ }).click();
      await page.getByRole("button", { name: "Zoom in" }).click();
      await page.locator(".clip-video").nth(1).locator(".clip-fx").first().waitFor();
    });

    await step("barn-door transition blends at the cut", async () => {
      await page.getByRole("tab", { name: /Transitions/ }).click();
      await page.getByRole("button", { name: "Barn door" }).click();
      await seekTo(6.02);
      const centre = await pixel(0.5, 0.5), edge = await pixel(0.05, 0.5);
      if (!(centre[2] > 150 && edge[1] > 150)) throw new Error(`centre ${centre} edge ${edge}`);
      await shot("01-transition");
    });

    await step("silence removal cuts the muted 2.0–3.5 s and the magnetic timeline closes the gap", async () => {
      await page.locator(".clip-video").first().click();
      await page.getByRole("tab", { name: /Tools/ }).click();
      await page.getByRole("button", { name: "Remove silence" }).click();
      await page.getByRole("status").filter({ hasText: /Removed 1 silent part/ }).waitFor({ timeout: 30000 });
      await page.waitForFunction(() => document.querySelectorAll(".clip-video").length === 3);
      const starts = await page.locator(".clip-video").evaluateAll((els) => els.map((e) => Number(e.getAttribute("aria-label")!.match(/at ([\d.]+) seconds/)![1])).sort((a, b) => a - b));
      if (!(Math.abs(starts[2] - 4.5) < 0.15)) throw new Error(`clip starts ${starts}`);
    });

    await step("beat detection adds markers on the music", async () => {
      await page.getByRole("tab", { name: /Import/ }).click();
      await page.getByRole("button", { name: "Add beats.wav to timeline" }).click();
      await page.locator(".clip-audio").click();
      await page.getByRole("tab", { name: /Tools/ }).click();
      await page.getByRole("button", { name: "Add beat markers" }).click();
      await page.waitForFunction(() => document.querySelectorAll(".marker").length >= 6, null, { timeout: 15000 });
      await page.locator(".clip-audio .waveform").waitFor();
    });

    const starts = () => page.locator(".clip-video").evaluateAll((els) => els.map((e) => Number(e.getAttribute("aria-label")!.match(/at ([\d.]+) seconds/)![1])).sort((a, b) => a - b));
    await step("magnetic delete pulls later clips left; undo restores", async () => {
      const before = await starts();
      await page.locator(".clip-video[aria-label*='at 0.0 seconds']").click();
      await page.keyboard.press("Delete");
      await page.waitForFunction(() => document.querySelectorAll(".clip-video").length === 2);
      const after = await starts();
      // the first piece (2.0 s long) is gone, so everything after it moves 2 s left
      if (!(after[0] === 0 && Math.abs(after[1] - (before[2] - 2)) < 0.15)) throw new Error(`starts ${before} → ${after}`);
      await page.keyboard.press("Control+Z");
      await page.waitForFunction(() => document.querySelectorAll(".clip-video").length === 3);
      await shot("02-editor");
    });

    const mp4 = f("export.mp4");
    await step("export MP4 with the detected (hardware) encoder", async () => {
      await page.getByRole("button", { name: "Export", exact: true }).click();
      const dlg = page.getByRole("dialog", { name: "Export video" });
      await dlg.getByLabel("Encoder").locator("option").first().waitFor({ state: "attached" });
      await page.waitForFunction(() => !document.querySelector<HTMLSelectElement>("select[aria-label=Encoder]")?.textContent?.includes("Detecting"));
      const enc = await dlg.getByLabel("Encoder").inputValue();
      console.log(`      encoder chosen: ${enc}`);
      await dlg.getByLabel("Resolution").selectOption("360");
      await dlg.getByLabel("Save to").fill(mp4);
      await dlg.getByRole("button", { name: "Start" }).click();
      await dlg.getByRole("status").filter({ hasText: /Saved in/ }).waitFor({ timeout: 180000 });
      const info: any = await page.evaluate((p) => (window as any).native.verify(p), mp4);
      if (info.video?.codec !== "h264" || info.video.height !== 360 || info.audio?.codec !== "aac") throw new Error(JSON.stringify(info));
      const timelineEnd = Math.max(...(await starts()).map((x, i, a) => x)) + 3; // last clip is the 3 s AVI
      if (Math.abs(info.duration - timelineEnd) > 0.25) throw new Error(`duration ${info.duration}, timeline ends ${timelineEnd}`);
      const px: number[] = await page.evaluate((p) => (window as any).native.sample(p, 0.5, 300, 170), mp4);
      if (!(px[0] > 170 && px[1] < 90)) throw new Error(`first frame not red: ${px}`);
      await dlg.getByRole("button", { name: "Close" }).click();
    });

    await step("export animated GIF", async () => {
      if (await page.getByRole("dialog", { name: "Export video" }).count()) await page.mouse.click(5, 5); // close a leftover dialog
      await page.getByRole("button", { name: "Export", exact: true }).click();
      const dlg = page.getByRole("dialog", { name: "Export video" });
      await dlg.getByRole("radio", { name: /GIF/ }).click();
      await dlg.getByLabel("Resolution").selectOption("360");
      await dlg.getByLabel("Save to").fill(f("export.gif"));
      await dlg.getByRole("button", { name: "Start" }).click();
      await dlg.getByRole("status").filter({ hasText: /Saved in/ }).waitFor({ timeout: 180000 });
      const info: any = await page.evaluate((p) => (window as any).native.verify(p), f("export.gif"));
      if (info.video?.codec !== "gif") throw new Error(JSON.stringify(info));
      await dlg.getByRole("button", { name: "Close" }).click();
    });

    await step("project persists across an app restart", async () => {
      const n = await page.locator(".clip").count();
      await page.waitForTimeout(800); // autosave debounce
      await app.close();
      app = await launch();
      page = await app.firstWindow();
      watch(page);
      await page.locator(".project-name").first().click({ timeout: 20000 });
      await page.waitForFunction((k) => document.querySelectorAll(".clip").length === k, n, { timeout: 15000 });
      await seekTo(0.5);
      const [r] = await pixel(0.5, 0.5);
      if (r < 170) throw new Error("media not restored");
      await shot("03-reopened");
    });

    await step("no renderer errors", async () => { if (errors.length) throw new Error(errors.slice(0, 3).join(" | ")); });
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} step(s) failed — screenshots in ${SHOTS}` : `\nall e2e steps passed — screenshots in ${SHOTS}`);
  process.exit(failures ? 1 : 0);
}
main();
