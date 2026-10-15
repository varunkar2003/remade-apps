import { useEffect, useState } from "react";
import { newProject, projectDuration, type Project } from "./model";
import { deleteProject, getProject, listProjects, saveProject } from "./storage";
import { Editor } from "./ui/Editor";

const route = () => location.hash.match(/^#\/p\/(.+)$/)?.[1] ?? null;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

export function App() {
  const [id, setId] = useState(route);
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const f = () => setId(route()); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  useEffect(() => {
    setProject(null);
    if (!id) return;
    getProject(id).then((p) => (p ? setProject(p) : setError("That project doesn't exist any more."))).catch((e) => setError(String(e)));
  }, [id]);

  if (id && project) return <Editor key={project.id} initial={project} onExit={() => { location.hash = ""; }} />;
  if (id && !error) return <div className="center muted">Loading project…</div>;
  return <Home error={error} />;
}

function Home({ error }: { error: string | null }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const refresh = () => listProjects().then(setProjects);
  useEffect(() => { refresh(); }, []);
  async function create() {
    const p = newProject();
    await saveProject(p);
    location.hash = `#/p/${p.id}`;
  }
  return (
    <div className="home">
      <header className="home-head">
        <div className="brand"><span className="logo" aria-hidden>▶</span> Movavi Remake <span className="muted small">Video Editor</span></div>
      </header>
      <main className="home-main">
        {error && <div className="banner error" role="alert">{error}</div>}
        <button className="create-card" onClick={create}>
          <span className="plus" aria-hidden>＋</span>
          <span><b>New project</b><br /><span className="muted">Import clips, edit, export with hardware acceleration</span></span>
        </button>
        <h2>Your videos</h2>
        {!projects ? <p className="muted">Loading…</p> : !projects.length ? <p className="muted">No videos yet.</p> : (
          <div className="project-grid">
            {projects.map((p) => {
              const thumb = p.assets.find((a) => a.thumb)?.thumb;
              return (
                <div key={p.id} className="project-card">
                  <a href={`#/p/${p.id}`} className="project-thumb" style={thumb ? { backgroundImage: `url(${thumb})` } : undefined} aria-label={`Open ${p.name}`}>
                    <span className="badge">{fmt(projectDuration(p))}</span>
                  </a>
                  <div className="project-meta">
                    <a href={`#/p/${p.id}`} className="project-name">{p.name}</a>
                    <span className="muted">{p.aspect} · {new Date(p.updatedAt).toLocaleDateString()}</span>
                  </div>
                  <button className="icon-btn" aria-label={`Delete ${p.name}`} title="Delete"
                    onClick={async () => { await deleteProject(p); refresh(); }}>🗑</button>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
