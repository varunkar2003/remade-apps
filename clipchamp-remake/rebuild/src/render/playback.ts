// Preview engine: one media element per timeline item, kept in sync with a master clock.
// Video elements double as the audio for preview; audio items use <audio>.
import { assetUrl } from "../storage";
import type { Asset, Item, Project } from "../model";
import type { Source } from "./compositor";

const SYNC_TOLERANCE = 0.12;

export class MediaPool {
  private els = new Map<string, HTMLVideoElement | HTMLAudioElement>();
  private images = new Map<string, HTMLImageElement>();
  private ready = new Set<string>(); // item ids whose element has decoded the requested frame
  onFrame: () => void = () => {};

  async sync(p: Project) {
    const live = new Set<string>();
    for (const it of p.items) {
      const a = p.assets.find((x) => x.id === it.assetId);
      if (!a) continue;
      if (a.kind === "image") {
        if (!this.images.has(a.id)) {
          const img = new Image();
          img.src = await assetUrl(a.id);
          img.decode().then(() => this.onFrame()).catch(() => {});
          this.images.set(a.id, img);
        }
        continue;
      }
      live.add(it.id);
      if (this.els.has(it.id)) continue;
      const el = document.createElement(a.kind === "video" ? "video" : "audio") as HTMLVideoElement;
      el.preload = "auto";
      el.crossOrigin = "anonymous";
      if (el instanceof HTMLVideoElement) el.playsInline = true;
      el.src = await assetUrl(a.id);
      const id = it.id;
      el.addEventListener("seeked", () => { this.ready.add(id); this.onFrame(); });
      el.addEventListener("loadeddata", () => { this.ready.add(id); this.onFrame(); });
      this.els.set(it.id, el);
    }
    for (const [id, el] of this.els) if (!live.has(id)) { el.pause(); el.removeAttribute("src"); el.load(); this.els.delete(id); this.ready.delete(id); }
  }

  sourceTime = (it: Item, t: number) => it.trimStart + (t - it.start) * it.speed;

  /** Seek every element to where it should be at time t (paused). */
  seek(p: Project, t: number) {
    for (const it of p.items) {
      const el = this.els.get(it.id);
      if (!el) continue;
      el.pause();
      const want = this.sourceTime(it, Math.min(Math.max(t, it.start), it.start + it.duration - 0.001));
      if (Math.abs(el.currentTime - want) > 0.001) { this.ready.delete(it.id); el.currentTime = Math.max(0, want); }
    }
  }

  /** Called every animation frame while playing. */
  tick(p: Project, t: number, playing: boolean) {
    for (const it of p.items) {
      const el = this.els.get(it.id);
      if (!el) continue;
      const track = p.tracks.find((tr) => tr.id === it.trackId);
      const active = t >= it.start && t < it.start + it.duration;
      if (!playing || !active) { if (!el.paused) el.pause(); continue; }
      const want = this.sourceTime(it, t);
      if (Math.abs(el.currentTime - want) > SYNC_TOLERANCE) el.currentTime = want;
      el.playbackRate = it.speed;
      const fade = Math.min(1, it.fadeIn > 0 ? (t - it.start) / it.fadeIn : 1, it.fadeOut > 0 ? (it.start + it.duration - t) / it.fadeOut : 1);
      el.volume = Math.max(0, Math.min(1, it.volume * fade));
      el.muted = it.muted || !!track?.muted;
      if (el.paused) el.play().catch(() => {});
    }
  }

  pauseAll() { for (const el of this.els.values()) el.pause(); }

  source = (asset: Asset | undefined, it: Item): Source | null => {
    if (!asset) return null;
    if (asset.kind === "image") {
      const img = this.images.get(asset.id);
      return img?.complete && img.naturalWidth ? { image: img, width: img.naturalWidth, height: img.naturalHeight } : null;
    }
    const v = this.els.get(it.id);
    if (!(v instanceof HTMLVideoElement) || v.readyState < 2) return null;
    return { image: v, width: v.videoWidth, height: v.videoHeight };
  };

  isSettled(p: Project, t: number) {
    return p.items.every((it) => !(t >= it.start && t < it.start + it.duration) || !this.els.has(it.id) || this.ready.has(it.id));
  }

  dispose() { for (const el of this.els.values()) { el.pause(); el.removeAttribute("src"); el.load(); } this.els.clear(); }
}
