import { useEffect, useRef, useState } from "react";
import { projectDuration, type Project } from "../model";
import { exportMp4 } from "../render/exporter";
import { fmtTime } from "./Editor";

export function ExportDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [height, setHeight] = useState<480 | 720 | 1080>(720);
  const [state, setState] = useState<{ phase: "idle" | "running" | "done" | "error"; progress: number; stage: string; url?: string; size?: number; error?: string }>({ phase: "idle", progress: 0, stage: "" });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => { abort.current?.abort(); if (state.url) URL.revokeObjectURL(state.url); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function run() {
    abort.current = new AbortController();
    setState({ phase: "running", progress: 0, stage: "Preparing" });
    const t0 = performance.now();
    try {
      const blob = await exportMp4(project, { height, signal: abort.current.signal, onProgress: (progress, stage) => setState((s) => ({ ...s, progress, stage })) });
      setState({ phase: "done", progress: 1, stage: `Finished in ${((performance.now() - t0) / 1000).toFixed(1)}s`, url: URL.createObjectURL(blob), size: blob.size });
    } catch (e) {
      if ((e as Error).name === "AbortError") setState({ phase: "idle", progress: 0, stage: "" });
      else setState({ phase: "error", progress: 0, stage: "", error: (e as Error).message });
    }
  }
  const safeName = project.name.replace(/[^\w\- ]+/g, "").trim() || "video";

  return (
    <div className="overlay" role="dialog" aria-label="Export video" onMouseDown={(e) => e.target === e.currentTarget && state.phase !== "running" && onClose()}>
      <div className="dialog">
        <h2>Export video</h2>
        <p className="muted">{fmtTime(projectDuration(project))} · {project.aspect} · MP4 (H.264)</p>
        {state.phase === "idle" || state.phase === "error" ? (
          <>
            <div className="row" role="radiogroup" aria-label="Resolution">
              {([480, 720, 1080] as const).map((h) => (
                <button key={h} role="radio" aria-checked={height === h} className={`res-btn${height === h ? " on" : ""}`} onClick={() => setHeight(h)}>
                  <b>{h}p</b><span className="muted small">{h === 480 ? "Smallest file" : h === 720 ? "Good for sharing" : "Best quality"}</span>
                </button>
              ))}
            </div>
            {state.error && <p className="error" role="alert">{state.error}</p>}
            <div className="row end"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={run}>Export</button></div>
          </>
        ) : state.phase === "running" ? (
          <>
            <div className="progress" role="progressbar" aria-valuenow={Math.round(state.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ width: `${state.progress * 100}%` }} />
            </div>
            <p className="muted">{state.stage}… {Math.round(state.progress * 100)}%</p>
            <div className="row end"><button className="btn" onClick={() => abort.current?.abort()}>Cancel</button></div>
          </>
        ) : (
          <>
            <video className="result" src={state.url} controls aria-label="Exported video" />
            <p className="muted">{state.stage} · {((state.size ?? 0) / 1048576).toFixed(1)} MB</p>
            <div className="row end">
              <button className="btn" onClick={onClose}>Close</button>
              <a className="btn primary" href={state.url} download={`${safeName}.mp4`}>Download</a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
