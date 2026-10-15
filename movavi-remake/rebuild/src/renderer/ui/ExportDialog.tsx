// Export, Movavi-style: pick a destination type (video file / audio / device / online),
// then format, resolution, quality and encoder (hardware encoders are detected by trial).
import { useEffect, useRef, useState } from "react";
import { projectDuration, type Project } from "../model";
import { exportVideo } from "../render/exporter";
import { native, type EncoderInfo, type ExportJob } from "../storage";
import { fmtTime } from "./Editor";

type Format = ExportJob["format"];
const FORMATS: { id: Format; label: string; note: string; codec: "h264" | "hevc" | null }[] = [
  { id: "mp4", label: "MP4 (H.264)", note: "Plays everywhere", codec: "h264" },
  { id: "mov", label: "MOV (ProRes)", note: "For further editing", codec: null },
  { id: "webm", label: "WebM (VP9)", note: "For the web", codec: null },
  { id: "gif", label: "GIF", note: "Animated, no sound", codec: null },
  { id: "mp3", label: "MP3", note: "Audio only", codec: null },
];
const PRESETS: { name: string; format: Format; height: number; quality: ExportJob["quality"] }[] = [
  { name: "YouTube 1080p", format: "mp4", height: 1080, quality: "high" },
  { name: "Phone / social 720p", format: "mp4", height: 720, quality: "medium" },
  { name: "Email (small)", format: "mp4", height: 480, quality: "small" },
];

export function ExportDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [format, setFormat] = useState<Format>("mp4");
  const [height, setHeight] = useState(720);
  const [quality, setQuality] = useState<ExportJob["quality"]>("medium");
  const [encoders, setEncoders] = useState<EncoderInfo[] | null>(null);
  const [encoder, setEncoder] = useState("libx264");
  const [out, setOut] = useState("");
  const [state, setState] = useState<{ phase: "setup" | "running" | "done" | "error"; progress: number; stage: string; result?: string; error?: string }>({ phase: "setup", progress: 0, stage: "" });
  const abort = useRef<AbortController | null>(null);
  const ext = format;
  const safeName = project.name.replace(/[^\w\- ]+/g, "").trim() || "video";

  useEffect(() => {
    native.encoders().then((e) => {
      setEncoders(e);
      const hw = e.find((x) => x.hardware && x.codec === "h264");
      if (hw) setEncoder(hw.id);
    }).catch(() => setEncoders([]));
  }, []);
  useEffect(() => { setOut((o) => (o ? o.replace(/\.[a-z0-9]+$/i, `.${ext}`) : o)); }, [ext]);

  async function browse() {
    const p = await native.pickExportPath(safeName, ext);
    if (p) setOut(p);
  }
  async function run() {
    let target = out.trim();
    if (!target) { const p = await native.pickExportPath(safeName, ext); if (!p) return; target = p; setOut(p); }
    abort.current = new AbortController();
    setState({ phase: "running", progress: 0, stage: "Preparing" });
    try {
      const r = await exportVideo(project, { out: target, format, height, quality, encoder: format === "mp4" ? encoder : undefined, signal: abort.current.signal,
        onProgress: (progress, stage) => setState((s) => ({ ...s, progress, stage })) });
      setState({ phase: "done", progress: 1, stage: `Saved in ${r.seconds.toFixed(1)} s · ${(r.bytes / 1048576).toFixed(1)} MB`, result: target });
    } catch (e) {
      if ((e as Error).name === "AbortError") setState({ phase: "setup", progress: 0, stage: "" });
      else setState({ phase: "error", progress: 0, stage: "", error: (e as Error).message });
    }
  }
  const h264 = (encoders ?? []).filter((e) => e.codec === "h264");

  return (
    <div className="overlay" role="dialog" aria-label="Export video" onMouseDown={(e) => e.target === e.currentTarget && state.phase !== "running" && onClose()}>
      <div className="dialog wide">
        <h2>Export</h2>
        <p className="muted">{fmtTime(projectDuration(project))} · {project.aspect}</p>
        {state.phase === "setup" || state.phase === "error" ? (
          <>
            <div className="preset-row">
              {PRESETS.map((p) => (
                <button key={p.name} className="chip-btn" onClick={() => { setFormat(p.format); setHeight(p.height); setQuality(p.quality); }}>{p.name}</button>
              ))}
            </div>
            <div className="format-grid" role="radiogroup" aria-label="Format">
              {FORMATS.map((f) => (
                <button key={f.id} role="radio" aria-checked={format === f.id} className={`res-btn${format === f.id ? " on" : ""}`} onClick={() => setFormat(f.id)}>
                  <b>{f.label}</b><span className="muted small">{f.note}</span>
                </button>
              ))}
            </div>
            {format !== "mp3" && (
              <div className="row">
                <label className="field-label">Resolution
                  <select className="field" aria-label="Resolution" value={height} onChange={(e) => setHeight(Number(e.target.value))}>
                    {[360, 480, 720, 1080, 1440, 2160].map((h) => <option key={h} value={h}>{h}p</option>)}
                  </select></label>
                <label className="field-label">Quality
                  <select className="field" aria-label="Quality" value={quality} onChange={(e) => setQuality(e.target.value as ExportJob["quality"])}>
                    <option value="high">High</option><option value="medium">Medium</option><option value="small">Small file</option>
                  </select></label>
              </div>
            )}
            {format === "mp4" && (
              <label className="field-label">Encoder
                <select className="field" aria-label="Encoder" value={encoder} onChange={(e) => setEncoder(e.target.value)}>
                  {!encoders && <option>Detecting hardware…</option>}
                  {h264.map((e) => <option key={e.id} value={e.id}>{e.label}{e.hardware ? " — hardware accelerated" : ""}</option>)}
                </select></label>
            )}
            <label className="field-label">Save to
              <div className="row"><input className="field" aria-label="Save to" value={out} placeholder={`…\\${safeName}.${ext}`} onChange={(e) => setOut(e.target.value)} />
                <button className="btn" onClick={browse}>Browse…</button></div></label>
            {state.error && <p className="error" role="alert">{state.error}</p>}
            <div className="row end"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={run}>Start</button></div>
          </>
        ) : state.phase === "running" ? (
          <>
            <div className="progress" role="progressbar" aria-valuenow={Math.round(state.progress * 100)} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${state.progress * 100}%` }} /></div>
            <p className="muted">{state.stage}… {Math.round(state.progress * 100)}%</p>
            <div className="row end"><button className="btn" onClick={() => abort.current?.abort()}>Cancel</button></div>
          </>
        ) : (
          <>
            <p role="status">✔ {state.stage}</p>
            <p className="muted small path">{state.result}</p>
            <div className="row end">
              <button className="btn" onClick={onClose}>Close</button>
              <button className="btn primary" onClick={() => state.result && native.reveal(state.result)}>Open folder</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
