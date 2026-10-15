// Multi-track timeline: move (with snapping and cross-track drag), trim handles, split,
// delete, zoom, drop media from the library, playhead scrubbing.
import { useEffect, useRef, useState } from "react";
import { closeGaps, fitsAt, freeSlot, makeItem, maxDuration, projectDuration, trackKindFor, uid, type Item, type Project } from "../model";
import type { EditorApi } from "./Editor";
import { fmtTime } from "./Editor";

const LABEL_W = 92;
const SNAP_PX = 8;

export function Timeline({ api, playing, onSplit, onDelete }: { api: EditorApi; playing: boolean; onSplit: () => void; onDelete: () => void }) {
  const { project, update, commit, time, seek, selected, select } = api;
  const [pps, setPps] = useState(60); // pixels per second
  const scroller = useRef<HTMLDivElement>(null);
  const duration = projectDuration(project);
  const width = Math.max((duration + 10) * pps, 800);

  // keep the playhead in view while playing
  useEffect(() => {
    const el = scroller.current;
    if (!el || !playing) return;
    const x = time * pps;
    if (x > el.scrollLeft + el.clientWidth - 60 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 80);
  }, [time, playing, pps]);

  const xToTime = (clientX: number) => {
    const r = scroller.current!.getBoundingClientRect();
    return Math.max(0, (clientX - r.left - LABEL_W + scroller.current!.scrollLeft) / pps);
  };

  // ---- playhead scrubbing on the ruler
  function onRulerDown(e: React.PointerEvent) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    seek(xToTime(e.clientX));
    const move = (ev: PointerEvent) => seek(xToTime(ev.clientX));
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }

  // ---- item drag: mode = move | trim-left | trim-right
  function onItemDown(e: React.PointerEvent, it: Item, mode: "move" | "trim-left" | "trim-right") {
    e.stopPropagation();
    if (e.button !== 0) return;
    select(it.id);
    const before = project;
    const asset = project.assets.find((a) => a.id === it.assetId);
    const x0 = e.clientX;
    const edges = [0, time, ...(project.markers ?? []), ...project.items.filter((o) => o.id !== it.id).flatMap((o) => [o.start, o.start + o.duration])];
    const snap = (t: number) => {
      for (const s of edges) if (Math.abs(s - t) * pps < SNAP_PX) return s;
      return t;
    };
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) / pps;
      if (Math.abs(ev.clientX - x0) > 2) moved = true;
      if (!moved) return;
      update((p) => {
        const cur = p.items.find((i) => i.id === it.id);
        if (!cur) return p;
        let next: Item = cur;
        if (mode === "move") {
          // vertical: drop onto the lane under the pointer if it's the same kind
          const lane = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-track]");
          const trackId = lane && p.tracks.find((t) => t.id === lane.dataset.track && t.kind === trackKindFor(it.kind)) ? lane.dataset.track! : it.trackId;
          let start = Math.max(0, it.start + dt);
          const sStart = snap(start), sEnd = snap(start + it.duration) - it.duration;
          start = sStart !== start ? sStart : sEnd !== start ? sEnd : start;
          if (!fitsAt(p, trackId, start, it.duration, it.id)) return p;
          next = { ...cur, start, trackId };
        } else if (mode === "trim-left") {
          const minStart = asset && asset.kind !== "image" ? it.start - it.trimStart / it.speed : 0;
          let start = Math.min(Math.max(snap(it.start + dt), Math.max(0, minStart)), it.start + it.duration - 0.1);
          const delta = start - it.start;
          if (!fitsAt(p, it.trackId, start, it.duration - delta, it.id)) return p;
          next = { ...cur, start, duration: it.duration - delta, trimStart: asset && asset.kind !== "image" ? it.trimStart + delta * it.speed : 0 };
        } else {
          const maxD = maxDuration(it, asset);
          let end = snap(it.start + it.duration + dt);
          let dur = Math.min(Math.max(0.1, end - it.start), maxD);
          if (!fitsAt(p, it.trackId, it.start, dur, it.id)) return p;
          next = { ...cur, duration: dur };
        }
        return { ...p, items: p.items.map((i) => (i.id === it.id ? next : i)) };
      }, "transient");
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      if (moved) {
        if (project.magnetic || before.magnetic) {
          update((p) => {
            const cur = p.items.find((i) => i.id === it.id);
            let next = closeGaps(p, it.trackId);
            if (cur && cur.trackId !== it.trackId) next = closeGaps(next, cur.trackId);
            return next;
          }, "transient");
        }
        commit(before);
      }
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }

  // ---- drop from the media library
  function onDrop(e: React.DragEvent, trackId: string | null) {
    e.preventDefault();
    const assetId = e.dataTransfer.getData("application/x-asset");
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset) return;
    const kind = asset.kind;
    const dur = kind === "image" ? 5 : asset.duration;
    const t = xToTime(e.clientX);
    const lane = trackId ? project.tracks.find((tr) => tr.id === trackId) : null;
    const compatible = lane && lane.kind === trackKindFor(kind);
    const target = compatible ? lane!.id : uid();
    const start = compatible ? freeSlot(project, target, t, dur) : t;
    api.addItem(makeItem(kind, target, start, dur, { assetId: asset.id, fit: "contain" }), !compatible);
  }

  const ticks: number[] = [];
  const step = pps >= 80 ? 1 : pps >= 40 ? 2 : pps >= 15 ? 5 : 10;
  for (let s = 0; s * pps < width; s += step) ticks.push(s);

  const toggleTrack = (id: string, key: "muted" | "hidden") => update((p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === id ? { ...t, [key]: !t[key] } : t)) }));
  const removeTrack = (id: string) => update((p) => ({ ...p, tracks: p.tracks.filter((t) => t.id !== id), items: p.items.filter((i) => i.trackId !== id) }));

  return (
    <section className="timeline" aria-label="Timeline">
      <div className="timeline-tools">
        <button className="tool-btn" onClick={onSplit} title="Split at playhead (S)">✂ Split</button>
        <button className="tool-btn" onClick={onDelete} disabled={!selected} title="Delete (Del)">🗑 Delete</button>
        <button className="tool-btn" onClick={() => api.addMarker(time)} title="Add marker (M)">⚑ Marker</button>
        <button className={`tool-btn${project.magnetic ? " on" : ""}`} aria-pressed={!!project.magnetic} title="Magnetic timeline: no gaps between clips"
          onClick={() => update((p) => ({ ...p, magnetic: !p.magnetic }))}>🧲 Magnetic</button>
        <span className="muted">{fmtTime(time)}</span>
        <span className="spacer" />
        <label className="zoom"><span className="muted">Zoom</span>
          <input type="range" min={8} max={240} value={pps} onChange={(e) => setPps(Number(e.target.value))} aria-label="Timeline zoom" /></label>
        <button className="tool-btn" onClick={() => scroller.current && setPps(Math.max(8, Math.min(240, (scroller.current.clientWidth - LABEL_W - 40) / Math.max(1, duration))))}>Fit</button>
      </div>
      <div className="timeline-scroll" ref={scroller}>
        <div className="timeline-inner" style={{ width: width + LABEL_W }}>
          <div className="ruler" style={{ marginLeft: LABEL_W }} onPointerDown={onRulerDown} aria-label="Timeline ruler">
            {ticks.map((s) => <span key={s} className="tick" style={{ left: s * pps }}>{Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</span>)}
            {(project.markers ?? []).map((m) => (
              <button key={m} className="marker" style={{ left: m * pps }} aria-label={`Marker at ${m.toFixed(2)} seconds`} title="Click: jump · Double-click: remove"
                onPointerDown={(e) => { e.stopPropagation(); seek(m); }} onDoubleClick={() => api.addMarker(m)} />
            ))}
          </div>
          {project.tracks.map((tr) => (
            <div key={tr.id} className={`track track-${tr.kind}`}>
              <div className="track-label" style={{ width: LABEL_W }}>
                <span aria-hidden>{tr.kind === "audio" ? "♪" : "▣"}</span>
                <button className={`mini${tr.muted ? " on" : ""}`} onClick={() => toggleTrack(tr.id, "muted")} aria-label={tr.muted ? "Unmute track" : "Mute track"} aria-pressed={tr.muted}>{tr.muted ? "🔇" : "🔊"}</button>
                {tr.kind === "visual" && <button className={`mini${tr.hidden ? " on" : ""}`} onClick={() => toggleTrack(tr.id, "hidden")} aria-label={tr.hidden ? "Show track" : "Hide track"} aria-pressed={tr.hidden}>{tr.hidden ? "🚫" : "👁"}</button>}
                {project.tracks.filter((t) => t.kind === tr.kind).length > 1 && !project.items.some((i) => i.trackId === tr.id) &&
                  <button className="mini" onClick={() => removeTrack(tr.id)} aria-label="Remove empty track">✕</button>}
              </div>
              <div className="lane" data-track={tr.id} onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e, tr.id)}
                onPointerDown={(e) => { if (e.target === e.currentTarget) { select(null); seek(xToTime(e.clientX)); } }}>
                {project.items.filter((i) => i.trackId === tr.id).map((it) => (
                  <ClipView key={it.id} it={it} project={project} pps={pps} selected={selected === it.id} onDown={onItemDown} onOpen={() => api.setLeftTab("props")} />
                ))}
              </div>
            </div>
          ))}
          <div className="new-track-drop" style={{ marginLeft: LABEL_W }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e, null)}>
            Drop here to add a new track
          </div>
          <div className="playhead" style={{ left: LABEL_W + time * pps }} aria-hidden />
        </div>
      </div>
    </section>
  );
}

function ClipView({ it, project, pps, selected, onDown, onOpen }: {
  it: Item; project: Project; pps: number; selected: boolean;
  onDown: (e: React.PointerEvent, it: Item, mode: "move" | "trim-left" | "trim-right") => void;
  onOpen: () => void;
}) {
  const asset = project.assets.find((a) => a.id === it.assetId);
  const label = it.kind === "text" ? it.text?.content.split("\n")[0] || "Text" : asset?.name ?? "Missing media";
  const style: React.CSSProperties = { left: it.start * pps, width: Math.max(4, it.duration * pps) };
  if (asset?.thumb && it.kind !== "audio") style.backgroundImage = `url(${asset.thumb})`;
  return (
    <div className={`clip clip-${it.kind}${selected ? " selected" : ""}`} style={style} role="button" tabIndex={0}
      aria-label={`${it.kind} clip ${label} at ${it.start.toFixed(1)} seconds`} aria-pressed={selected}
      onPointerDown={(e) => onDown(e, it, "move")} onDoubleClick={onOpen} title="Double-click for clip properties">
      {it.transitionIn.type !== "none" && <span className="clip-transition" title={`Transition: ${it.transitionIn.type}`}>◆</span>}
      {asset?.waveform && (it.kind === "audio" || it.kind === "video") && <Waveform peaks={asset.waveform} from={it.trimStart} seconds={it.duration * it.speed} />}
      {it.panZoom && <span className="clip-fx" title="Pan & Zoom">⤢</span>}
      {(it.effects?.length ?? 0) > 0 && <span className="clip-fx second" title={`${it.effects!.length} effect(s)`}>✦{it.effects!.length}</span>}
      <span className="clip-label">{it.speed !== 1 ? `${it.speed}× · ` : ""}{label}</span>
      <span className="handle left" onPointerDown={(e) => onDown(e, it, "trim-left")} aria-label="Trim start" />
      <span className="handle right" onPointerDown={(e) => onDown(e, it, "trim-right")} aria-label="Trim end" />
    </div>
  );
}

/** Peak waveform of the visible part of the source (50 peaks per second). */
function Waveform({ peaks, from, seconds }: { peaks: number[]; from: number; seconds: number }) {
  const a = Math.floor(from * 50), b = Math.min(peaks.length, Math.ceil((from + seconds) * 50));
  const slice = peaks.slice(a, b);
  if (!slice.length) return null;
  const step = Math.max(1, Math.floor(slice.length / 400));
  const pts: string[] = [];
  for (let i = 0; i < slice.length; i += step) pts.push(`${(i / slice.length) * 100},${50 - Math.min(1, slice[i] * 2.5) * 48}`);
  const top = pts.join(" ");
  const bottom = pts.map((p) => { const [x, y] = p.split(","); return `${x},${100 - Number(y)}`; }).reverse().join(" ");
  return <svg className="waveform" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden><polygon points={`${top} ${bottom}`} /></svg>;
}
