import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ASPECTS, closeGaps, projectDuration, size, splitItem, uid, type Aspect, type Item, type Project } from "../model";
import { Compositor } from "../render/compositor";
import { MediaPool } from "../render/playback";
import { saveProject } from "../storage";
import { ExportDialog } from "./ExportDialog";
import { LeftPanel, type LeftTab } from "./Panels";
import { Timeline } from "./Timeline";

export const fmtTime = (s: number) => {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60), cs = Math.floor((s % 1) * 100);
  return `${m}:${String(sec).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
};

/** Undo history. `update(next, "transient")` changes the view without a history entry (mid-drag);
 *  `commit(before)` then records the pre-drag state once. */
function useHistory(initial: Project) {
  const [state, setState] = useState({ past: [] as Project[], present: initial, future: [] as Project[] });
  const ref = useRef(state);
  ref.current = state;
  const update = useCallback((next: Project | ((p: Project) => Project), mode: "push" | "transient" = "push") => {
    setState((s) => {
      const n = typeof next === "function" ? next(s.present) : next;
      if (n === s.present) return s;
      return mode === "push" ? { past: [...s.past.slice(-99), s.present], present: n, future: [] } : { ...s, present: n };
    });
  }, []);
  const commit = useCallback((before: Project) => {
    setState((s) => (s.present === before ? s : { past: [...s.past.slice(-99), before], present: s.present, future: [] }));
  }, []);
  const undo = useCallback(() => setState((s) => (s.past.length ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future] } : s)), []);
  const redo = useCallback(() => setState((s) => (s.future.length ? { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1) } : s)), []);
  return { project: state.present, update, commit, undo, redo, canUndo: state.past.length > 0, canRedo: state.future.length > 0, ref };
}

export interface EditorApi {
  project: Project;
  update: (next: Project | ((p: Project) => Project), mode?: "push" | "transient") => void;
  commit: (before: Project) => void;
  time: number;
  seek: (t: number) => void;
  selected: string | null;
  select: (id: string | null) => void;
  addItem: (item: Item, newTrack?: boolean) => void;
  leftTab: LeftTab;
  setLeftTab: (t: LeftTab) => void;
  addMarker: (t: number) => void;
}

export function Editor({ initial, onExit }: { initial: Project; onExit: () => void }) {
  const h = useHistory(initial);
  const { project, update, commit, undo, redo } = h;
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [leftTab, setLeftTab] = useState<LeftTab>("media");

  const [saveState, setSaveState] = useState<"saved" | "saving">("saved");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const comp = useRef<Compositor | null>(null);
  const pool = useMemo(() => new MediaPool(), []);
  const timeRef = useRef(0);
  timeRef.current = time;
  const projRef = useRef(project);
  projRef.current = project;
  const duration = projectDuration(project);
  const [W, H] = size(project);

  // autosave
  useEffect(() => {
    setSaveState("saving");
    const t = setTimeout(() => saveProject(project).then(() => setSaveState("saved")), 400);
    return () => clearTimeout(t);
  }, [project]);

  // compositor + media
  useEffect(() => {
    try { comp.current = new Compositor(canvasRef.current!); } catch (e) { console.error(e); }
    return () => pool.dispose();
  }, [pool]);
  const draw = useCallback(() => {
    const c = comp.current, p = projRef.current;
    if (!c) return;
    c.render(p, timeRef.current, (it) => pool.source(p.assets.find((a) => a.id === it.assetId), it));
  }, [pool]);
  useEffect(() => { pool.onFrame = draw; }, [pool, draw]);
  useEffect(() => { pool.sync(project).then(() => { if (!playing) pool.seek(project, timeRef.current); draw(); }); comp.current?.prune(project); }, [project]); // eslint-disable-line react-hooks/exhaustive-deps

  // paused: seek + redraw when time or content changes
  useEffect(() => { if (!playing) { pool.seek(project, time); draw(); } }, [time, project, playing, pool, draw]);

  // playing: master clock drives media + rendering
  useEffect(() => {
    if (!playing) { pool.pauseAll(); return; }
    let raf = 0;
    const t0 = performance.now(), start = timeRef.current >= duration - 0.05 ? 0 : timeRef.current;
    const loop = () => {
      const t = start + (performance.now() - t0) / 1000;
      if (t >= duration) { setTime(duration); setPlaying(false); return; }
      timeRef.current = t;
      setTime(t);
      pool.tick(projRef.current, t, true);
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps

  const seek = useCallback((t: number) => { setPlaying(false); setTime(Math.max(0, Math.min(t, Math.max(duration, 0)))); }, [duration]);

  const addItem = useCallback((item: Item, newTrack = false) => {
    update((p) => {
      let tracks = p.tracks;
      let trackId = item.trackId;
      if (newTrack || !tracks.some((t) => t.id === trackId)) {
        const kind = item.kind === "audio" ? "audio" : "visual";
        const t = { id: uid(), kind, muted: false, hidden: false } as const;
        // new visual tracks go on top; new audio tracks at the bottom
        tracks = kind === "visual" ? [t, ...tracks] : [...tracks, t];
        trackId = t.id;
      }
      return { ...p, tracks, items: [...p.items, { ...item, trackId }] };
    });
    setSelected(item.id);
  }, [update]);

  const sel = project.items.find((i) => i.id === selected) ?? null;
  const addMarker = useCallback((t: number) => update((p) => {
    const ms = p.markers ?? [];
    return ms.some((m) => Math.abs(m - t) < 0.05) ? { ...p, markers: ms.filter((m) => Math.abs(m - t) >= 0.05) } : { ...p, markers: [...ms, t].sort((a, b) => a - b) };
  }), [update]);
  const deleteSelected = useCallback(() => {
    if (!selected) return;
    update((p) => {
      const it = p.items.find((i) => i.id === selected);
      const next = { ...p, items: p.items.filter((i) => i.id !== selected) };
      return it && p.magnetic ? closeGaps(next, it.trackId) : next;
    });
    setSelected(null);
  }, [selected, update]);
  const splitSelected = useCallback(() => {
    const p = projRef.current;
    const target = (selected && p.items.find((i) => i.id === selected && timeRef.current > i.start && timeRef.current < i.start + i.duration))
      ?? p.items.find((i) => timeRef.current > i.start && timeRef.current < i.start + i.duration);
    if (!target) return;
    const next = splitItem(p, target.id, timeRef.current);
    if (next) update(next);
  }, [selected, update]);
  const duplicateSelected = useCallback(() => {
    const it = projRef.current.items.find((i) => i.id === selected);
    if (it) addItem({ ...it, id: uid(), start: it.start + it.duration, transitionIn: { ...it.transitionIn, type: "none" } }, false);
  }, [selected, addItem]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement).isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === " ") { e.preventDefault(); setPlaying((v) => !v); }
      else if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
      else if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSelected(); }
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); }
      else if (e.key.toLowerCase() === "s" && !mod) { e.preventDefault(); splitSelected(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); seek(timeRef.current - (e.shiftKey ? 1 : 1 / project.fps)); }
      else if (e.key === "ArrowRight") { e.preventDefault(); seek(timeRef.current + (e.shiftKey ? 1 : 1 / project.fps)); }
      else if (e.key === "Home") seek(0);
      else if (e.key === "End") seek(duration);
      else if (e.key === "Escape") setSelected(null);
      else if (e.key.toLowerCase() === "m" && !mod) { e.preventDefault(); addMarker(timeRef.current); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [undo, redo, deleteSelected, splitSelected, duplicateSelected, seek, duration, project.fps, addMarker]);

  // drag the selected visual item around the preview
  const dragRef = useRef<{ id: string; x0: number; y0: number; ix: number; iy: number; before: Project } | null>(null);
  function onPreviewDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!sel || sel.kind === "audio") return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { id: sel.id, x0: e.clientX, y0: e.clientY, ix: sel.x, iy: sel.y, before: project };
  }
  function onPreviewMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = dragRef.current;
    if (!d) return;
    const r = (e.target as HTMLElement).getBoundingClientRect();
    const nx = d.ix + (e.clientX - d.x0) / r.width, ny = d.iy + (e.clientY - d.y0) / r.height;
    const snap = (v: number) => (Math.abs(v - 0.5) < 0.015 ? 0.5 : v);
    update((p) => ({ ...p, items: p.items.map((i) => (i.id === d.id ? { ...i, x: snap(nx), y: snap(ny) } : i)) }), "transient");
  }
  function onPreviewUp() { if (dragRef.current) { commit(dragRef.current.before); dragRef.current = null; } }

  // text/colour fields: one undo step per focus session
  const editBefore = useRef<Project | null>(null);
  const beginEdit = () => { editBefore.current = projRef.current; };
  const endEdit = () => { if (editBefore.current) commit(editBefore.current); editBefore.current = null; };

  const api: EditorApi = { project, update, commit, time, seek, selected, select: setSelected, addItem, leftTab, setLeftTab, addMarker };

  return (
    <div className="editor">
      <header className="topbar">
        <button className="icon-btn" onClick={onExit} aria-label="Back to home" title="Home">←</button>
        <input className="title-input" aria-label="Project name" value={project.name}
          onFocus={beginEdit} onChange={(e) => update((p) => ({ ...p, name: e.target.value }), "transient")} onBlur={endEdit} />
        <span className="muted save-state">{saveState === "saved" ? "Saved" : "Saving…"}</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={undo} disabled={!h.canUndo} aria-label="Undo" title="Undo (Ctrl+Z)">↶</button>
        <button className="icon-btn" onClick={redo} disabled={!h.canRedo} aria-label="Redo" title="Redo (Ctrl+Y)">↷</button>
        <label className="aspect">
          <span className="sr">Aspect ratio</span>
          <select aria-label="Aspect ratio" value={project.aspect} onChange={(e) => update((p) => ({ ...p, aspect: e.target.value as Aspect }))}>
            {(Object.keys(ASPECTS) as Aspect[]).map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <button className="btn primary" onClick={() => { setPlaying(false); setExporting(true); }} disabled={duration <= 0}>Export</button>
      </header>

      <LeftPanel api={api} />

      <section className="preview-area" aria-label="Preview">
        <div className="stage" style={{ aspectRatio: `${W} / ${H}` }}>
          <canvas ref={canvasRef} className="preview-canvas" aria-label="Video preview" width={W} height={H}
            onPointerDown={onPreviewDown} onPointerMove={onPreviewMove} onPointerUp={onPreviewUp} />
          {!project.items.length && <div className="stage-hint">Add media from the left, then drag it onto the timeline</div>}
        </div>
        <div className="transport">
          <span className="timecode" aria-label="Current time">{fmtTime(time)}</span>
          <span className="muted">/ {fmtTime(duration)}</span>
          <span className="spacer" />
          <button className="icon-btn" aria-label="Skip to start" onClick={() => seek(0)}>⏮</button>
          <button className="play-btn" aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying((v) => !v)} disabled={duration <= 0}>{playing ? "❚❚" : "▶"}</button>
          <button className="icon-btn" aria-label="Skip to end" onClick={() => seek(duration)}>⏭</button>
          <span className="spacer" />
          <label className="muted bg-pick">Background <input type="color" aria-label="Background colour" value={project.background}
            onFocus={beginEdit} onChange={(e) => update((p) => ({ ...p, background: e.target.value }), "transient")} onBlur={endEdit} /></label>
        </div>
      </section>

      <Timeline api={api} playing={playing} onSplit={splitSelected} onDelete={deleteSelected} />

      {exporting && <ExportDialog project={project} onClose={() => setExporting(false)} />}
    </div>
  );
}

