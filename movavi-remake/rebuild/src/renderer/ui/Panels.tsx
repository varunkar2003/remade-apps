// Left panel, Movavi-style: Import · Effects · Transitions · Titles · Tools · Clip properties.
import { useEffect, useRef, useState } from "react";
import {
  freeSlot, makeItem, maxDuration, NO_FILTERS, parseCube, previousAdjacent, removeRanges, uid,
  type Effect, type EffectType, type Filters, type Item, type TextStyle, type TransitionType,
} from "../model";
import { importFile, native, removeFile } from "../storage";
import type { EditorApi } from "./Editor";
import { fmtTime } from "./Editor";

export type LeftTab = "media" | "effects" | "transitions" | "titles" | "tools" | "props";

const TEXT_PRESETS: { name: string; style: TextStyle; y: number }[] = [
  { name: "Title", y: 0.5, style: { content: "Your title", font: "Segoe UI, sans-serif", size: 72, color: "#ffffff", background: "transparent", bold: true, align: "center" } },
  { name: "Subtitle", y: 0.84, style: { content: "Add a subtitle", font: "Segoe UI, sans-serif", size: 34, color: "#ffffff", background: "rgba(0,0,0,0.6)", bold: false, align: "center" } },
  { name: "Lower third", y: 0.8, style: { content: "Name Surname\nRole", font: "Segoe UI, sans-serif", size: 30, color: "#ffffff", background: "#2d9cdb", bold: true, align: "left" } },
  { name: "Cinematic", y: 0.5, style: { content: "THE END", font: "Georgia, serif", size: 90, color: "#f2e8cf", background: "transparent", bold: false, align: "center" } },
  { name: "Neon", y: 0.5, style: { content: "NEON", font: "Arial Black, sans-serif", size: 120, color: "#39ff14", background: "transparent", bold: true, align: "center" } },
  { name: "Typewriter", y: 0.5, style: { content: "Once upon a time…", font: "Consolas, monospace", size: 48, color: "#e8e8e8", background: "transparent", bold: false, align: "center" } },
];

export const TRANSITIONS: { type: TransitionType; label: string; group: string }[] = [
  { type: "crossfade", label: "Dissolve", group: "Fades" }, { type: "fadeblack", label: "Through black", group: "Fades" }, { type: "flash", label: "Flash", group: "Fades" }, { type: "dissolve", label: "Noise dissolve", group: "Fades" },
  { type: "wipeleft", label: "Wipe right", group: "Wipes" }, { type: "wiperight", label: "Wipe left", group: "Wipes" }, { type: "wipeup", label: "Wipe up", group: "Wipes" }, { type: "wipedown", label: "Wipe down", group: "Wipes" },
  { type: "barndoor", label: "Barn door", group: "Wipes" }, { type: "blinds", label: "Blinds", group: "Wipes" }, { type: "radial", label: "Clock", group: "Wipes" }, { type: "circle", label: "Circle", group: "Wipes" },
  { type: "slideleft", label: "Push left", group: "Motion" }, { type: "slideright", label: "Push right", group: "Motion" }, { type: "slice", label: "Slices", group: "Motion" },
  { type: "zoom", label: "Zoom", group: "Motion" }, { type: "spin", label: "Spin", group: "Motion" }, { type: "ripple", label: "Ripple", group: "Distort" }, { type: "pixelate", label: "Pixels", group: "Distort" },
];

export const EFFECTS: { type: EffectType; label: string; group: string; amount: number; color?: string }[] = [
  { type: "chromakey", label: "Chroma key", group: "Keying", amount: 0.4, color: "#00ff00" },
  { type: "vignette", label: "Vignette", group: "Look", amount: 0.6 }, { type: "grain", label: "Film grain", group: "Look", amount: 0.4 },
  { type: "oldfilm", label: "Old movie", group: "Look", amount: 0.9 }, { type: "tiltshift", label: "Tilt-shift", group: "Look", amount: 0.6 },
  { type: "sharpen", label: "Sharpen", group: "Look", amount: 0.4 },
  { type: "vhs", label: "VHS", group: "Retro", amount: 0.7 }, { type: "glitch", label: "Glitch", group: "Retro", amount: 0.6 },
  { type: "chromatic", label: "Chromatic aberration", group: "Retro", amount: 0.6 }, { type: "posterize", label: "Posterize", group: "Artistic", amount: 0.6 },
  { type: "popart", label: "Pop art", group: "Artistic", amount: 1 }, { type: "edges", label: "Find edges", group: "Artistic", amount: 1 },
  { type: "mosaic", label: "Mosaic", group: "Artistic", amount: 0.4 }, { type: "mirror", label: "Mirror", group: "Artistic", amount: 1 },
  { type: "invert", label: "Invert", group: "Artistic", amount: 1 },
];

export const FILTER_PRESETS: { name: string; f: Partial<Filters> }[] = [
  { name: "Original", f: {} }, { name: "Black & white", f: { grayscale: 1, contrast: 0.1 } }, { name: "Sepia", f: { sepia: 0.85 } },
  { name: "Vivid", f: { saturation: 0.6, contrast: 0.15 } }, { name: "Muted", f: { saturation: -0.5 } }, { name: "Cool", f: { hue: 0.08, saturation: 0.1, brightness: -0.03 } },
  { name: "Warm", f: { hue: -0.05, saturation: 0.2, brightness: 0.03 } }, { name: "Noir", f: { grayscale: 1, contrast: 0.45, brightness: -0.08 } },
];

const TABS: [LeftTab, string, string][] = [["media", "⤓", "Import"], ["effects", "✦", "Effects"], ["transitions", "◆", "Transitions"], ["titles", "T", "Titles"], ["tools", "⚒", "Tools"], ["props", "☰", "Clip properties"]];

export function LeftPanel({ api }: { api: EditorApi }) {
  const tab = api.leftTab;
  return (
    <aside className="left-panel">
      <nav className="left-tabs" role="tablist" aria-label="Library">
        {TABS.map(([id, icon, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => api.setLeftTab(id)}>
            <span className="tab-icon" aria-hidden>{icon}</span>{label}
          </button>
        ))}
      </nav>
      <div className="left-body">
        {tab === "media" && <MediaTab api={api} />}
        {tab === "effects" && <EffectsTab api={api} />}
        {tab === "transitions" && <TransitionTab api={api} />}
        {tab === "titles" && <TitlesTab api={api} />}
        {tab === "tools" && <ToolsTab api={api} />}
        {tab === "props" && <Inspector api={api} />}
      </div>
    </aside>
  );
}

const selectedItem = (api: EditorApi) => api.project.items.find((i) => i.id === api.selected);
const patchItem = (api: EditorApi, id: string, patch: Partial<Item> | ((i: Item) => Partial<Item>)) =>
  api.update((p) => ({ ...p, items: p.items.map((i) => (i.id === id ? { ...i, ...(typeof patch === "function" ? patch(i) : patch) } : i)) }));

function MediaTab({ api }: { api: EditorApi }) {
  const { project, update } = api;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const [progress, setProgress] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  useEffect(() => native.onImportProgress((p) => setProgress(`${p.stage} ${p.name}… ${Math.round(p.fraction * 100)}%`)), []);

  async function add(list: (File | string)[]) {
    setBusy((n) => n + list.length);
    for (const f of list) {
      try {
        const asset = await importFile(f);
        update((p) => ({ ...p, assets: [...p.assets, asset] }));
      } catch (e) { setErrors((er) => [...er, (e as Error).message]); }
      finally { setBusy((n) => n - 1); setProgress(null); }
    }
  }
  function addToTimeline(assetId: string) {
    const p = project;
    const a = p.assets.find((x) => x.id === assetId)!;
    const dur = a.kind === "image" ? 5 : a.duration;
    const track = p.tracks.find((t) => t.kind === (a.kind === "audio" ? "audio" : "visual"));
    const trackId = track?.id ?? "new";
    const lastEnd = p.items.filter((i) => i.trackId === trackId).reduce((m, i) => Math.max(m, i.start + i.duration), 0);
    api.addItem(makeItem(a.kind, trackId, track ? freeSlot(p, trackId, lastEnd, dur) : 0, dur, { assetId: a.id }), !track);
  }
  function remove(assetId: string) {
    update((p) => ({ ...p, assets: p.assets.filter((a) => a.id !== assetId), items: p.items.filter((i) => i.assetId !== assetId) }));
    removeFile(assetId).catch(() => {});
  }

  return (
    <div className={`media-tab${over ? " drop-over" : ""}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setOver(false); add(Array.from(e.dataTransfer.files)); } }}>
      <h3>Import files</h3>
      <div className="row">
        <button className="btn primary" onClick={async () => add(await native.pickMedia())}>＋ Add files</button>
        <button className="btn" onClick={() => input.current?.click()}>Browse…</button>
      </div>
      <input ref={input} type="file" multiple hidden aria-label="Import media files" onChange={(e) => { if (e.target.files) add(Array.from(e.target.files)); e.target.value = ""; }} />
      <p className="muted small">Any format FFmpeg reads — MKV, AVI, MOV, WMV and more are converted for editing automatically. Or drop files here.</p>
      {busy > 0 && <p className="muted" role="status">{progress ?? `Importing ${busy}…`}</p>}
      {errors.map((er, i) => <p key={i} className="error small" role="alert">{er}</p>)}
      <div className="asset-grid">
        {project.assets.map((a) => (
          <div key={a.id} className="asset" draggable onDragStart={(e) => { e.dataTransfer.setData("application/x-asset", a.id); e.dataTransfer.effectAllowed = "copy"; }} title={`${a.name}\n${a.codec ?? ""}${a.proxy ? " (converted)" : ""}`}>
            <div className="asset-thumb" style={a.thumb ? { backgroundImage: `url(${a.thumb})` } : undefined}>
              {a.kind === "audio" && <span className="asset-glyph">♪</span>}
              {a.proxy && <span className="proxy-badge">proxy</span>}
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

function needSelection(it: Item | undefined, visual = true) {
  if (!it) return "Select a clip on the timeline first.";
  if (visual && it.kind === "audio") return "Select a video, image or title clip.";
  return null;
}

function EffectsTab({ api }: { api: EditorApi }) {
  const it = selectedItem(api);
  const why = needSelection(it);
  const groups = [...new Set(EFFECTS.map((e) => e.group))];
  return (
    <div className="preset-list">
      <h3>Effects</h3>
      <p className="muted small">{why ?? "Click an effect to add it to the selected clip. Effects stack in order; adjust them in Clip properties."}</p>
      {groups.map((g) => (
        <section key={g}>
          <h4>{g}</h4>
          <div className="grid2">
            {EFFECTS.filter((e) => e.group === g).map((e) => (
              <button key={e.type} className="fx-tile" disabled={!!why}
                onClick={() => it && patchItem(api, it.id, (i) => ({ effects: [...(i.effects ?? []), { id: uid(), type: e.type, amount: e.amount, color: e.color }] }))}>
                <span className={`fx-swatch fx-${e.type}`} aria-hidden />{e.label}
              </button>
            ))}
          </div>
        </section>
      ))}
      <h4>Colour looks</h4>
      <div className="grid2">
        {FILTER_PRESETS.map((f) => (
          <button key={f.name} className="chip-btn" disabled={!!why} onClick={() => it && patchItem(api, it.id, { filters: { ...NO_FILTERS, ...f.f } })}>{f.name}</button>
        ))}
      </div>
    </div>
  );
}

function TransitionTab({ api }: { api: EditorApi }) {
  const it = selectedItem(api);
  const prev = it && previousAdjacent(api.project, it);
  const groups = [...new Set(TRANSITIONS.map((t) => t.group))];
  return (
    <div className="preset-list">
      <h3>Transitions</h3>
      <p className="muted small">{prev ? "Applies between the selected clip and the clip before it." : "Select a clip that directly follows another clip on the same track."}</p>
      {groups.map((g) => (
        <section key={g}>
          <h4>{g}</h4>
          <div className="grid2">
            {TRANSITIONS.filter((t) => t.group === g).map((t) => (
              <button key={t.type} className={`chip-btn${it?.transitionIn.type === t.type ? " on" : ""}`} disabled={!prev}
                onClick={() => it && patchItem(api, it.id, (i) => ({ transitionIn: { type: t.type, duration: i.transitionIn.duration || 0.8 } }))}>{t.label}</button>
            ))}
          </div>
        </section>
      ))}
      <button className="btn wide" disabled={api.project.items.length < 2} onClick={() => api.update((p) => ({
        ...p, items: p.items.map((i) => (previousAdjacent(p, i) && i.kind !== "audio" ? { ...i, transitionIn: { type: "crossfade", duration: 0.8 } } : i)),
      }))}>Transition wizard: dissolve between all clips</button>
    </div>
  );
}

function TitlesTab({ api }: { api: EditorApi }) {
  return (
    <div className="preset-list">
      <h3>Titles</h3>
      {TEXT_PRESETS.map((t) => (
        <button key={t.name} className="text-preset" onClick={() => api.addItem(makeItem("text", "new", api.time, 4, { text: { ...t.style }, y: t.y, fadeIn: 0.3, fadeOut: 0.3 }), true)}>
          <span style={{ fontFamily: t.style.font, fontWeight: t.style.bold ? 700 : 400, color: t.style.color, background: t.style.background === "transparent" ? "#2a2f36" : t.style.background }}>{t.name}</span>
        </button>
      ))}
      <p className="muted small">Titles go on a new track above your video at the playhead.</p>
    </div>
  );
}

function ToolsTab({ api }: { api: EditorApi }) {
  const it = selectedItem(api);
  const asset = it && api.project.assets.find((a) => a.id === it.assetId);
  const [msg, setMsg] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(-35);
  const [minGap, setMinGap] = useState(0.5);
  const [busy, setBusy] = useState(false);

  async function removeSilence() {
    if (!it || !asset) return;
    setBusy(true); setMsg("Detecting silence with FFmpeg…");
    try {
      const ranges = await native.silence(asset.id, threshold, minGap);
      const before = api.project.items.length;
      const next = removeRanges(api.project, it.id, ranges.map((r) => ({ start: r.start, end: Number.isFinite(r.end) ? r.end : asset.duration })));
      api.update(next);
      setMsg(ranges.length ? `Removed ${ranges.length} silent part${ranges.length > 1 ? "s" : ""} (${next.items.length - before + 1} pieces kept).` : "No silence found at this threshold.");
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  }
  async function beatMarkers() {
    if (!it || !asset) return;
    setBusy(true);
    try {
      const beats = asset.beats ?? (await native.analyzeAudio(asset.id)).beats;
      const inClip = beats.map((b) => it.start + (b - it.trimStart) / it.speed).filter((t) => t >= it.start && t <= it.start + it.duration);
      api.update((p) => ({ ...p, markers: [...new Set([...(p.markers ?? []), ...inClip.map((t) => Math.round(t * 100) / 100)])].sort((a, b) => a - b) }));
      setMsg(`Added ${inClip.length} beat markers — clips snap to them.`);
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  }
  async function importLut() {
    if (!it || it.kind === "audio") return;
    const f = await native.pickLut();
    if (!f) return;
    try {
      const lut = parseCube(f.name, f.text);
      patchItem(api, it.id, (i) => ({ effects: [...(i.effects ?? []), { id: uid(), type: "lut", amount: 1, lut }] }));
      setMsg(`Applied ${f.name} (${lut.size}³ LUT).`);
    } catch (e) { setMsg((e as Error).message); }
  }

  const visual = it && it.kind !== "audio" && it.kind !== "text";
  return (
    <div className="preset-list">
      <h3>Tools</h3>
      <section>
        <h4>Pan & Zoom</h4>
        <p className="muted small">{visual ? "Animated zoom across the selected clip (Ken Burns)." : "Select a video or image clip."}</p>
        <div className="grid2">
          {([["Zoom in", { x: 0.5, y: 0.5, scale: 1 }, { x: 0.5, y: 0.5, scale: 1.4 }], ["Zoom out", { x: 0.5, y: 0.5, scale: 1.4 }, { x: 0.5, y: 0.5, scale: 1 }],
            ["Pan right", { x: 0.35, y: 0.5, scale: 1.3 }, { x: 0.65, y: 0.5, scale: 1.3 }], ["Pan left", { x: 0.65, y: 0.5, scale: 1.3 }, { x: 0.35, y: 0.5, scale: 1.3 }]] as const).map(([label, from, to]) => (
            <button key={label} className={`chip-btn${it?.panZoom && it.panZoom.from.x === from.x && it.panZoom.to.scale === to.scale ? " on" : ""}`} disabled={!visual}
              onClick={() => it && patchItem(api, it.id, { panZoom: { from: { ...from }, to: { ...to } } })}>{label}</button>
          ))}
          <button className="chip-btn" disabled={!visual || !it?.panZoom} onClick={() => it && patchItem(api, it.id, { panZoom: null })}>Remove</button>
        </div>
      </section>
      <section>
        <h4>Silence removal</h4>
        <p className="muted small">{it && asset?.hasAudio ? "Cut the quiet parts out of the selected clip and close the gaps." : "Select a clip that has sound."}</p>
        <label className="slider"><span className="slider-head"><span>Threshold</span><span className="muted">{threshold} dB</span></span>
          <input type="range" min={-60} max={-15} value={threshold} aria-label="Silence threshold" onChange={(e) => setThreshold(Number(e.target.value))} /></label>
        <label className="slider"><span className="slider-head"><span>Minimum length</span><span className="muted">{minGap.toFixed(1)} s</span></span>
          <input type="range" min={0.2} max={3} step={0.1} value={minGap} aria-label="Minimum silence length" onChange={(e) => setMinGap(Number(e.target.value))} /></label>
        <button className="btn wide" disabled={!it || !asset?.hasAudio || busy} onClick={removeSilence}>Remove silence</button>
      </section>
      <section>
        <h4>Beat detection</h4>
        <p className="muted small">Put markers on the beats of the selected music clip.</p>
        <button className="btn wide" disabled={!it || !asset?.hasAudio || busy} onClick={beatMarkers}>Add beat markers</button>
      </section>
      <section>
        <h4>Colour grading</h4>
        <button className="btn wide" disabled={!it || it.kind === "audio"} onClick={importLut}>Import LUT (.cube)…</button>
      </section>
      {msg && <p className="muted small" role="status">{msg}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- clip properties
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

function Inspector({ api }: { api: EditorApi }) {
  const { project, update, commit, selected } = api;
  const it = project.items.find((i) => i.id === selected);
  const before = useRef(project);
  if (!it) return <div className="preset-list"><h3>Clip properties</h3><p className="muted small">Select a clip on the timeline to edit it.</p></div>;
  const asset = project.assets.find((a) => a.id === it.assetId);
  const prev = previousAdjacent(project, it);
  const set = (patch: Partial<Item>) => update((p) => ({ ...p, items: p.items.map((i) => (i.id === it.id ? { ...i, ...patch } : i)) }), "transient");
  const setF = (patch: Partial<Filters>) => set({ filters: { ...it.filters, ...patch } });
  const setT = (patch: Partial<TextStyle>) => set({ text: { ...it.text!, ...patch } });
  const setFx = (id: string, patch: Partial<Effect>) => set({ effects: (it.effects ?? []).map((e) => (e.id === id ? { ...e, ...patch } : e)) });
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
    <div className="inspector" aria-label="Clip properties" onPointerDownCapture={start} onFocusCapture={start}>
      <h3>{it.kind === "text" ? "Title" : it.kind === "audio" ? "Audio" : it.kind === "image" ? "Image" : "Video"} <span className="muted small">{asset?.name}</span></h3>
      <p className="muted small">{fmtTime(it.start)} → {fmtTime(it.start + it.duration)}{asset?.codec ? ` · ${asset.codec}` : ""}{asset?.proxy ? " · converted" : ""}</p>

      {it.kind === "text" && it.text && (
        <section>
          <h4>Text</h4>
          <textarea className="field" aria-label="Text content" rows={3} value={it.text.content} onChange={(e) => setT({ content: e.target.value })} onBlur={done} />
          <div className="row">
            <select className="field" aria-label="Font" value={it.text.font} onChange={(e) => setT({ font: e.target.value })} onBlur={done}>
              {["Segoe UI, sans-serif", "Georgia, serif", "Impact, sans-serif", "Consolas, monospace", "Arial Black, sans-serif", "Comic Sans MS, cursive"].map((f) => <option key={f} value={f}>{f.split(",")[0]}</option>)}
            </select>
            <button className={`chip-btn${it.text.bold ? " on" : ""}`} onClick={() => setT({ bold: !it.text!.bold })} onMouseUp={done} aria-pressed={it.text.bold}>B</button>
          </div>
          <Slider label="Size" value={it.text.size} min={12} max={200} step={1} fmt={(v) => `${v}`} onChange={(v) => setT({ size: v })} onDone={done} />
          <div className="row">
            <label className="color-field">Colour <input type="color" value={it.text.color} onChange={(e) => setT({ color: e.target.value })} onBlur={done} aria-label="Text colour" /></label>
            <label className="color-field">Box <input type="checkbox" checked={it.text.background !== "transparent"} aria-label="Text background" onChange={(e) => setT({ background: e.target.checked ? "#000000" : "transparent" })} onBlur={done} /></label>
          </div>
        </section>
      )}

      {visual && (it.effects?.length ?? 0) > 0 && (
        <section>
          <h4>Effects</h4>
          {it.effects!.map((e) => (
            <div key={e.id} className="fx-row">
              <div className="row"><b>{e.type === "lut" ? `LUT · ${e.lut?.name}` : EFFECTS.find((x) => x.type === e.type)?.label}</b><span className="spacer" />
                <button className="mini" aria-label={`Remove ${e.type}`} onClick={() => { set({ effects: it.effects!.filter((x) => x.id !== e.id) }); }} onMouseUp={done}>✕</button></div>
              <Slider label="Amount" value={e.amount} min={0} max={1} fmt={pct} onChange={(v) => setFx(e.id, { amount: v })} onDone={done} />
              {e.type === "chromakey" && <label className="color-field">Key colour <input type="color" aria-label="Key colour" value={e.color ?? "#00ff00"} onChange={(ev) => setFx(e.id, { color: ev.target.value })} onBlur={done} /></label>}
            </div>
          ))}
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
              <button className="chip-btn" onClick={() => set({ rotation: (it.rotation + 90) % 360 })} onMouseUp={done}>Rotate 90°</button>
            </div>
          )}
        </section>
      )}

      {visual && (
        <section>
          <h4>Colour adjustments</h4>
          <Slider label="Brightness" value={it.filters.brightness} min={-1} max={1} onChange={(v) => setF({ brightness: v })} onDone={done} />
          <Slider label="Contrast" value={it.filters.contrast} min={-1} max={1} onChange={(v) => setF({ contrast: v })} onDone={done} />
          <Slider label="Saturation" value={it.filters.saturation} min={-1} max={1} onChange={(v) => setF({ saturation: v })} onDone={done} />
          <Slider label="Hue" value={it.filters.hue} min={-1} max={1} onChange={(v) => setF({ hue: v })} onDone={done} />
          <Slider label="Blur" value={it.filters.blur} min={0} max={1} onChange={(v) => setF({ blur: v })} onDone={done} />
        </section>
      )}

      <section>
        <h4>Fade</h4>
        <Slider label="Fade in" value={it.fadeIn} min={0} max={Math.min(5, it.duration / 2)} step={0.1} fmt={(v) => `${v.toFixed(1)}s`} onChange={(v) => set({ fadeIn: v })} onDone={done} />
        <Slider label="Fade out" value={it.fadeOut} min={0} max={Math.min(5, it.duration / 2)} step={0.1} fmt={(v) => `${v.toFixed(1)}s`} onChange={(v) => set({ fadeOut: v })} onDone={done} />
      </section>

      {visual && prev && (
        <section>
          <h4>Transition in</h4>
          <select className="field" aria-label="Transition type" value={it.transitionIn.type} onChange={(e) => set({ transitionIn: { ...it.transitionIn, type: e.target.value as TransitionType } })} onBlur={done}>
            <option value="none">None</option>
            {TRANSITIONS.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
          </select>
          {it.transitionIn.type !== "none" && (
            <Slider label="Duration" value={it.transitionIn.duration} min={0.2} max={Math.max(0.3, Math.min(3, it.duration, prev.duration))} step={0.1}
              fmt={(v) => `${v.toFixed(1)}s`} onChange={(v) => set({ transitionIn: { ...it.transitionIn, duration: v } })} onDone={done} />
          )}
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
    </div>
  );
}
