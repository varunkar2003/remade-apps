import { useRef, useState } from "react";
import { freeSlot, makeItem, maxDuration, NO_FILTERS, previousAdjacent, type Filters, type Item, type TextStyle, type TransitionType } from "../model";
import { importFile, removeFile } from "../storage";
import type { EditorApi } from "./Editor";
import { fmtTime } from "./Editor";

const TEXT_PRESETS: { name: string; style: TextStyle; y: number }[] = [
  { name: "Title", y: 0.5, style: { content: "Your title", font: "Segoe UI, sans-serif", size: 72, color: "#ffffff", background: "transparent", bold: true, align: "center" } },
  { name: "Subtitle", y: 0.82, style: { content: "Add a subtitle", font: "Segoe UI, sans-serif", size: 36, color: "#ffffff", background: "rgba(0,0,0,0.6)", bold: false, align: "center" } },
  { name: "Lower third", y: 0.8, style: { content: "Name Surname\nRole", font: "Segoe UI, sans-serif", size: 30, color: "#111111", background: "#ffd400", bold: true, align: "left" } },
  { name: "Big & bold", y: 0.5, style: { content: "WOW", font: "Impact, sans-serif", size: 140, color: "#ff3b6b", background: "transparent", bold: true, align: "center" } },
  { name: "Typewriter", y: 0.5, style: { content: "Once upon a time…", font: "Consolas, monospace", size: 48, color: "#e8e8e8", background: "transparent", bold: false, align: "center" } },
];

export const TRANSITIONS: { type: TransitionType; label: string }[] = [
  { type: "crossfade", label: "Crossfade" }, { type: "fadeblack", label: "Fade through black" }, { type: "wipeleft", label: "Wipe right" },
  { type: "wiperight", label: "Wipe left" }, { type: "wipeup", label: "Wipe up" }, { type: "wipedown", label: "Wipe down" },
  { type: "slideleft", label: "Push left" }, { type: "slideright", label: "Push right" }, { type: "zoom", label: "Zoom" },
  { type: "circle", label: "Circle reveal" }, { type: "pixelate", label: "Pixelate" },
];

export const FILTER_PRESETS: { name: string; f: Partial<Filters> }[] = [
  { name: "Original", f: {} }, { name: "Black & white", f: { grayscale: 1, contrast: 0.1 } }, { name: "Sepia", f: { sepia: 0.85 } },
  { name: "Vivid", f: { saturation: 0.6, contrast: 0.15 } }, { name: "Muted", f: { saturation: -0.5 } }, { name: "Cool", f: { hue: 0.08, saturation: 0.1, brightness: -0.03 } },
  { name: "Warm", f: { hue: -0.05, saturation: 0.2, brightness: 0.03 } }, { name: "Dreamy", f: { blur: 0.12, brightness: 0.1, saturation: -0.1 } },
  { name: "Retro", f: { sepia: 0.4, contrast: -0.1, saturation: -0.2 } }, { name: "Noir", f: { grayscale: 1, contrast: 0.45, brightness: -0.08 } },
];

export function LeftPanel({ api }: { api: EditorApi }) {
  const [tab, setTab] = useState<"media" | "text" | "transitions" | "filters">("media");
  return (
    <aside className="left-panel">
      <nav className="left-tabs" role="tablist" aria-label="Library">
        {([["media", "🎞", "Your media"], ["text", "T", "Text"], ["transitions", "◆", "Transitions"], ["filters", "◐", "Filters"]] as const).map(([id, icon, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            <span className="tab-icon" aria-hidden>{icon}</span>{label}
          </button>
        ))}
      </nav>
      <div className="left-body">
        {tab === "media" && <MediaTab api={api} />}
        {tab === "text" && <TextTab api={api} />}
        {tab === "transitions" && <TransitionTab api={api} />}
        {tab === "filters" && <FilterTab api={api} />}
      </div>
    </aside>
  );
}

function MediaTab({ api }: { api: EditorApi }) {
  const { project, update } = api;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [over, setOver] = useState(false);

  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files);
    setBusy((n) => n + list.length);
    for (const f of list) {
      try {
        const asset = await importFile(f);
        update((p) => ({ ...p, assets: [...p.assets, asset] }));
      } catch (e) { setErrors((er) => [...er, (e as Error).message]); }
      finally { setBusy((n) => n - 1); }
    }
  }
  function addToTimeline(assetId: string) {
    const p = project;
    const a = p.assets.find((x) => x.id === assetId)!;
    const kind = a.kind;
    const dur = kind === "image" ? 5 : a.duration;
    const track = p.tracks.find((t) => t.kind === (kind === "audio" ? "audio" : "visual"));
    const trackId = track?.id ?? "new";
    const lastEnd = p.items.filter((i) => i.trackId === trackId).reduce((m, i) => Math.max(m, i.start + i.duration), 0);
    api.addItem(makeItem(kind, trackId, track ? freeSlot(p, trackId, lastEnd, dur) : 0, dur, { assetId: a.id }), !track);
  }
  async function remove(assetId: string) {
    if (project.items.some((i) => i.assetId === assetId) && !confirm("This media is used on the timeline. Remove it and its clips?")) return;
    update((p) => ({ ...p, assets: p.assets.filter((a) => a.id !== assetId), items: p.items.filter((i) => i.assetId !== assetId) }));
    removeFile(assetId).catch(() => {});
  }

  return (
    <div className={`media-tab${over ? " drop-over" : ""}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); } }}>
      <button className="btn primary wide" onClick={() => input.current?.click()}>＋ Import media</button>
      <input ref={input} type="file" multiple hidden accept="video/*,audio/*,image/*" aria-label="Import media files"
        onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
      <p className="muted small">Or drop files here. Media stays on this device.</p>
      {busy > 0 && <p className="muted" role="status">Importing {busy}…</p>}
      {errors.map((er, i) => <p key={i} className="error small" role="alert">{er}</p>)}
      <div className="asset-grid">
        {project.assets.map((a) => (
          <div key={a.id} className="asset" draggable onDragStart={(e) => { e.dataTransfer.setData("application/x-asset", a.id); e.dataTransfer.effectAllowed = "copy"; }}
            title={a.name}>
            <div className="asset-thumb" style={a.thumb ? { backgroundImage: `url(${a.thumb})` } : undefined}>
              {a.kind === "audio" && <span className="asset-glyph">♪</span>}
              {a.kind !== "image" && <span className="badge">{fmtTime(a.duration).replace(/\.\d+$/, "")}</span>}
              <button className="asset-add" onClick={() => addToTimeline(a.id)} aria-label={`Add ${a.name} to timeline`}>＋</button>
            </div>
            <div className="asset-name">{a.name}</div>
            <button className="asset-del" onClick={() => remove(a.id)} aria-label={`Remove ${a.name}`}>✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function TextTab({ api }: { api: EditorApi }) {
  return (
    <div className="preset-list">
      {TEXT_PRESETS.map((t) => (
        <button key={t.name} className="text-preset" onClick={() => api.addItem(makeItem("text", "new", api.time, 4, { text: { ...t.style }, y: t.y, fadeIn: 0.3, fadeOut: 0.3 }), true)}>
          <span style={{ fontFamily: t.style.font, fontWeight: t.style.bold ? 700 : 400, color: t.style.color, background: t.style.background === "transparent" ? "#333" : t.style.background }}>{t.name}</span>
        </button>
      ))}
      <p className="muted small">Text is added at the playhead on a new track above your video.</p>
    </div>
  );
}

function TransitionTab({ api }: { api: EditorApi }) {
  const it = api.project.items.find((i) => i.id === api.selected);
  const prev = it && previousAdjacent(api.project, it);
  return (
    <div className="preset-list">
      <p className="muted small">{prev ? "Applies between the selected clip and the clip before it." : "Select a clip that directly follows another clip on the same track."}</p>
      <div className="grid2">
        {TRANSITIONS.map((t) => (
          <button key={t.type} className={`chip-btn${it?.transitionIn.type === t.type ? " on" : ""}`} disabled={!prev}
            onClick={() => it && api.update((p) => ({ ...p, items: p.items.map((i) => (i.id === it.id ? { ...i, transitionIn: { type: t.type, duration: i.transitionIn.duration || 0.6 } } : i)) }))}>
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function FilterTab({ api }: { api: EditorApi }) {
  const it = api.project.items.find((i) => i.id === api.selected);
  const ok = it && it.kind !== "audio";
  return (
    <div className="preset-list">
      <p className="muted small">{ok ? "Click a look to apply it to the selected clip." : "Select a video, image or text clip."}</p>
      <div className="grid2">
        {FILTER_PRESETS.map((f) => (
          <button key={f.name} className="chip-btn" disabled={!ok}
            onClick={() => it && api.update((p) => ({ ...p, items: p.items.map((i) => (i.id === it.id ? { ...i, filters: { ...NO_FILTERS, ...f.f } } : i)) }))}>{f.name}</button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- inspector
function Slider({ label, value, min, max, step = 0.01, onChange, onDone, fmt }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; onDone: () => void; fmt?: (v: number) => string;
}) {
  return (
    <label className="slider">
      <span className="slider-head"><span>{label}</span><span className="muted">{fmt ? fmt(value) : value.toFixed(2)}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))} onPointerUp={onDone} onKeyUp={onDone} onBlur={onDone} />
    </label>
  );
}

export function Inspector({ api }: { api: EditorApi }) {
  const { project, update, commit, selected } = api;
  const it = project.items.find((i) => i.id === selected);
  const before = useRef(project);
  if (!it) {
    return (
      <aside className="inspector" aria-label="Properties">
        <h3>Properties</h3>
        <p className="muted small">Select a clip on the timeline to edit it.</p>
        <div className="shortcuts muted small">
          <b>Shortcuts</b><br />Space play/pause · S split · Del delete · Ctrl+Z / Ctrl+Y undo/redo · Ctrl+D duplicate · ←/→ frame step
        </div>
      </aside>
    );
  }
  const asset = project.assets.find((a) => a.id === it.assetId);
  const prev = previousAdjacent(project, it);
  const set = (patch: Partial<Item>) => update((p) => ({ ...p, items: p.items.map((i) => (i.id === it.id ? { ...i, ...patch } : i)) }), "transient");
  const setF = (patch: Partial<Filters>) => set({ filters: { ...it.filters, ...patch } });
  const setT = (patch: Partial<TextStyle>) => set({ text: { ...it.text!, ...patch } });
  const start = () => { before.current = project; };
  const done = () => commit(before.current);
  const visual = it.kind !== "audio";
  const hasSound = it.kind === "audio" || (it.kind === "video" && asset?.hasAudio);
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  function setSpeed(speed: number) {
    const srcLen = it!.duration * it!.speed;
    let dur = srcLen / speed;
    const next = project.items.filter((o) => o.trackId === it!.trackId && o.start > it!.start).sort((a, b) => a.start - b.start)[0];
    if (next) dur = Math.min(dur, next.start - it!.start);
    dur = Math.min(dur, maxDuration({ ...it!, speed }, asset));
    set({ speed, duration: Math.max(0.1, dur) });
  }

  return (
    <aside className="inspector" aria-label="Properties" onPointerDownCapture={start} onFocusCapture={start}>
      <h3>{it.kind === "text" ? "Text" : it.kind === "audio" ? "Audio" : it.kind === "image" ? "Image" : "Video"} <span className="muted small">{asset?.name}</span></h3>
      <p className="muted small">{fmtTime(it.start)} → {fmtTime(it.start + it.duration)}</p>

      {it.kind === "text" && it.text && (
        <section>
          <h4>Text</h4>
          <textarea className="field" aria-label="Text content" rows={3} value={it.text.content} onChange={(e) => setT({ content: e.target.value })} onBlur={done} />
          <div className="row">
            <select className="field" aria-label="Font" value={it.text.font} onChange={(e) => { setT({ font: e.target.value }); }} onBlur={done}>
              {["Segoe UI, sans-serif", "Georgia, serif", "Impact, sans-serif", "Consolas, monospace", "Comic Sans MS, cursive", "Arial Black, sans-serif"].map((f) => <option key={f} value={f}>{f.split(",")[0]}</option>)}
            </select>
            <button className={`chip-btn${it.text.bold ? " on" : ""}`} onClick={() => { setT({ bold: !it.text!.bold }); }} onMouseUp={done} aria-pressed={it.text.bold}>B</button>
          </div>
          <Slider label="Size" value={it.text.size} min={12} max={200} step={1} fmt={(v) => `${v}`} onChange={(v) => setT({ size: v })} onDone={done} />
          <div className="row">
            <label className="color-field">Colour <input type="color" value={it.text.color} onChange={(e) => setT({ color: e.target.value })} onBlur={done} aria-label="Text colour" /></label>
            <label className="color-field">Background
              <input type="checkbox" checked={it.text.background !== "transparent"} aria-label="Text background"
                onChange={(e) => { setT({ background: e.target.checked ? "#000000" : "transparent" }); }} onBlur={done} />
              {it.text.background !== "transparent" && <input type="color" aria-label="Background colour" value={it.text.background.startsWith("#") ? it.text.background : "#000000"} onChange={(e) => setT({ background: e.target.value })} onBlur={done} />}
            </label>
          </div>
          <div className="row">
            {(["left", "center", "right"] as const).map((a) => <button key={a} className={`chip-btn${it.text!.align === a ? " on" : ""}`} onClick={() => setT({ align: a })} onMouseUp={done}>{a}</button>)}
          </div>
        </section>
      )}

      {visual && (
        <section>
          <h4>Transform</h4>
          <Slider label="Scale" value={it.scale} min={0.1} max={3} fmt={pct} onChange={(v) => set({ scale: v })} onDone={done} />
          <Slider label="Position X" value={it.x} min={-0.5} max={1.5} fmt={pct} onChange={(v) => set({ x: v })} onDone={done} />
          <Slider label="Position Y" value={it.y} min={-0.5} max={1.5} fmt={pct} onChange={(v) => set({ y: v })} onDone={done} />
          <Slider label="Rotation" value={it.rotation} min={-180} max={180} step={1} fmt={(v) => `${v}°`} onChange={(v) => set({ rotation: v })} onDone={done} />
          <Slider label="Opacity" value={it.opacity} min={0} max={1} fmt={pct} onChange={(v) => set({ opacity: v })} onDone={done} />
          {it.kind !== "text" && (
            <div className="row">
              <button className={`chip-btn${it.fit === "contain" ? " on" : ""}`} onClick={() => set({ fit: "contain" })} onMouseUp={done}>Fit</button>
              <button className={`chip-btn${it.fit === "cover" ? " on" : ""}`} onClick={() => set({ fit: "cover" })} onMouseUp={done}>Fill</button>
              <button className="chip-btn" onClick={() => set({ x: 0.5, y: 0.5, scale: 1, rotation: 0 })} onMouseUp={done}>Reset</button>
            </div>
          )}
        </section>
      )}

      {visual && (
        <section>
          <h4>Adjust colours</h4>
          <Slider label="Brightness" value={it.filters.brightness} min={-1} max={1} onChange={(v) => setF({ brightness: v })} onDone={done} />
          <Slider label="Contrast" value={it.filters.contrast} min={-1} max={1} onChange={(v) => setF({ contrast: v })} onDone={done} />
          <Slider label="Saturation" value={it.filters.saturation} min={-1} max={1} onChange={(v) => setF({ saturation: v })} onDone={done} />
          <Slider label="Hue" value={it.filters.hue} min={-1} max={1} onChange={(v) => setF({ hue: v })} onDone={done} />
          <Slider label="Blur" value={it.filters.blur} min={0} max={1} onChange={(v) => setF({ blur: v })} onDone={done} />
          <Slider label="Black & white" value={it.filters.grayscale} min={0} max={1} onChange={(v) => setF({ grayscale: v })} onDone={done} />
        </section>
      )}

      <section>
        <h4>Fade</h4>
        <Slider label="Fade in" value={it.fadeIn} min={0} max={Math.min(5, it.duration / 2)} step={0.1} fmt={(v) => `${v.toFixed(1)}s`} onChange={(v) => set({ fadeIn: v })} onDone={done} />
        <Slider label="Fade out" value={it.fadeOut} min={0} max={Math.min(5, it.duration / 2)} step={0.1} fmt={(v) => `${v.toFixed(1)}s`} onChange={(v) => set({ fadeOut: v })} onDone={done} />
      </section>

      {visual && (
        <section>
          <h4>Transition in</h4>
          {prev ? (
            <>
              <select className="field" aria-label="Transition type" value={it.transitionIn.type}
                onChange={(e) => { set({ transitionIn: { ...it.transitionIn, type: e.target.value as TransitionType } }); }} onBlur={done}>
                <option value="none">None</option>
                {TRANSITIONS.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
              </select>
              {it.transitionIn.type !== "none" && (
                <Slider label="Duration" value={it.transitionIn.duration} min={0.2} max={Math.max(0.3, Math.min(3, it.duration, prev.duration))} step={0.1}
                  fmt={(v) => `${v.toFixed(1)}s`} onChange={(v) => set({ transitionIn: { ...it.transitionIn, duration: v } })} onDone={done} />
              )}
            </>
          ) : <p className="muted small">Place this clip directly after another clip on the same track to add a transition.</p>}
        </section>
      )}

      {(it.kind === "video" || it.kind === "audio") && (
        <section>
          <h4>Speed</h4>
          <div className="row wrap">
            {[0.25, 0.5, 1, 1.5, 2, 4].map((s) => <button key={s} className={`chip-btn${it.speed === s ? " on" : ""}`} onClick={() => setSpeed(s)} onMouseUp={done}>{s}×</button>)}
          </div>
        </section>
      )}

      {hasSound && (
        <section>
          <h4>Audio</h4>
          <Slider label="Volume" value={it.volume} min={0} max={2} fmt={pct} onChange={(v) => set({ volume: v })} onDone={done} />
          <label className="check"><input type="checkbox" checked={it.muted} onChange={(e) => set({ muted: e.target.checked })} onBlur={done} /> Mute this clip</label>
        </section>
      )}

      <section className="row">
        <button className="btn" onClick={() => { api.update((p) => ({ ...p, items: p.items.filter((i) => i.id !== it.id) })); api.select(null); }}>Delete clip</button>
      </section>
    </aside>
  );
}
