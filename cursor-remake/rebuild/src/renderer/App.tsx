import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Entry, type GrepHit, type IndexStatus, type Settings } from "./api";
import { ChatPanel } from "./Chat";
import { EditorArea, liveText, registerTabCompletions, type Review, type Selection, type Tab } from "./Editor";

export function App() {
  const [root, setRoot] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    api.getFolder().then((f) => { setRoot(f.root); setRecent(f.recent); });
    return api.onFolderOpened((r) => setRoot(r));
  }, []);
  if (!root) return <Welcome recent={recent} onOpen={setRoot} />;
  return <Workbench key={root} root={root} />;
}

function Welcome({ recent, onOpen }: { recent: string[]; onOpen: (r: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const open = async (p?: string) => {
    try { const r = p ? await api.openFolder(p) : await api.pickFolder(); if (r) onOpen(r); }
    catch (e) { setError((e as Error).message); }
  };
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="logo" aria-hidden>⌘</div>
        <h1>Cursor Remake</h1>
        <p className="muted">An AI code editor, rebuilt from scratch.</p>
        <button className="btn primary big" onClick={() => open()}>Open folder…</button>
        {error && <div className="error" role="alert">{error}</div>}
        {recent.length > 0 && <>
          <h3>Recent</h3>
          {recent.map((r) => <button key={r} className="linklike recent" onClick={() => open(r)}>{r}</button>)}
        </>}
      </div>
    </div>
  );
}

function Workbench({ root }: { root: string }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [review, setReview] = useState<(Review & { sid: string }) | null>(null);
  const [side, setSide] = useState<"files" | "search">("files");
  const [quickOpen, setQuickOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [termOpen, setTermOpen] = useState(false);
  const [index, setIndex] = useState<IndexStatus>({ state: "indexing" });
  const [selection, setSelection] = useState<Selection | null>(null);
  const [treeVersion, setTreeVersion] = useState(0);
  const [pendingVersion, setPendingVersion] = useState(0);
  const [chatFocus, setChatFocus] = useState(0);
  const [tabEnabled, setTabEnabled] = useState(true);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [reveal, setReveal] = useState<{ path: string; line: number; nonce: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const tabOn = useRef(tabEnabled);
  tabOn.current = tabEnabled;

  useEffect(() => {
    const d = registerTabCompletions(() => tabOn.current);
    return () => d.dispose();
  }, []);
  useEffect(() => api.onIndexStatus(setIndex), []);
  useEffect(() => { api.getSettings().then(setSettings); }, [settingsOpen]);

  const openFile = useCallback(async (path: string, line?: number) => {
    setReview(null);
    if (!tabsRef.current.some((t) => t.path === path)) {
      try {
        const text = await api.read(path);
        setTabs((ts) => (ts.some((t) => t.path === path) ? ts : [...ts, { path, text, saved: text }]));
      } catch (e) { setToast((e as Error).message); return; }
    }
    setActive(path);
    if (line) setReveal({ path, line, nonce: Date.now() });
  }, []);

  // reload open, unmodified tabs when files change on disk (agent edits, external tools)
  const reloadFromDisk = useCallback(async (paths: string[]) => {
    setTreeVersion((v) => v + 1);
    for (const p of paths) {
      const t = tabsRef.current.find((x) => x.path === p);
      if (!t || t.text !== t.saved) continue;
      try {
        const text = await api.read(p);
        setTabs((ts) => ts.map((x) => (x.path === p ? { ...x, text, saved: text } : x)));
      } catch {
        setTabs((ts) => ts.filter((x) => x.path !== p)); // deleted
      }
    }
  }, []);
  useEffect(() => api.onFsChanged((paths) => { reloadFromDisk(paths); setPendingVersion((v) => v + 1); }), [reloadFromDisk]);

  async function save(path: string) {
    const t = tabsRef.current.find((x) => x.path === path);
    if (!t) return;
    const text = liveText(path) ?? t.text;
    try { await api.write(path, text); setTabs((ts) => ts.map((x) => (x.path === path ? { ...x, text, saved: text } : x))); }
    catch (e) { setToast((e as Error).message); }
  }
  function close(path: string) {
    const t = tabsRef.current.find((x) => x.path === path);
    if (t && t.text !== t.saved && !window.confirm(`Discard unsaved changes to ${path}?`)) return;
    const idx = tabsRef.current.findIndex((x) => x.path === path);
    const rest = tabsRef.current.filter((x) => x.path !== path);
    setTabs(rest);
    if (active === path) setActive(rest[Math.min(idx, rest.length - 1)]?.path ?? null);
  }

  async function showReview(sid: string, path: string) {
    const original = await api.original(sid, path);
    let current = "";
    try { current = await api.read(path); } catch { current = ""; }
    setReview({ sid, path, original: original ?? "", current });
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "p") { e.preventDefault(); setQuickOpen(true); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); setSide("search"); }
      else if (mod && e.key === "`") { e.preventDefault(); setTermOpen((v) => !v); }
      else if (mod && e.key === ",") { e.preventDefault(); setSettingsOpen(true); }
      else if (mod && e.key.toLowerCase() === "l" && !(e.target as HTMLElement).closest(".monaco-editor")) { e.preventDefault(); setChatFocus((n) => n + 1); }
      else return;
      e.stopPropagation();
    };
    // capture phase so Monaco can't swallow app-level shortcuts
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  // Ctrl+S in the capture phase so it works whether focus is in Monaco, the tree or the chat
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const onSaveKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        if (activeRef.current) save(activeRef.current);
      }
    };
    window.addEventListener("keydown", onSaveKey, true);
    return () => window.removeEventListener("keydown", onSaveKey, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); }, [toast]);

  return (
    <div className={`workbench${termOpen ? " with-term" : ""}`}>
      <nav className="activity" aria-label="Views">
        <button className={side === "files" ? "on" : ""} onClick={() => setSide("files")} title="Explorer" aria-label="Explorer">🗀</button>
        <button className={side === "search" ? "on" : ""} onClick={() => setSide("search")} title="Search (Ctrl+Shift+F)" aria-label="Search">⌕</button>
        <span className="spacer" />
        <button onClick={() => setTermOpen((v) => !v)} title="Terminal (Ctrl+`)" aria-label="Toggle terminal">⌨</button>
        <button onClick={() => setSettingsOpen(true)} title="Settings (Ctrl+,)" aria-label="Settings">⚙</button>
      </nav>
      <aside className="sidebar">
        {side === "files"
          ? <Explorer root={root} version={treeVersion} active={active} onOpen={openFile} onError={setToast} />
          : <SearchPanel onOpen={openFile} />}
      </aside>
      <main className="main">
        <EditorArea tabs={tabs} active={active} review={review} revealLine={reveal}
          onSelect={(p) => { setReview(null); setActive(p); }} onClose={close}
          onChange={(p, text) => setTabs((ts) => ts.map((t) => (t.path === p ? { ...t, text } : t)))}
          onSave={save}
          onAddToChat={(s) => { setSelection(s.text ? s : null); setChatFocus((n) => n + 1); }}
          onAcceptReview={async (p) => { await api.accept(review!.sid, p); setReview(null); setPendingVersion((v) => v + 1); }}
          onRejectReview={async (p) => { await api.reject(review!.sid, p); setReview(null); reloadFromDisk([p]); setPendingVersion((v) => v + 1); }}
          onCloseReview={() => setReview(null)} />
        {termOpen && <Terminal />}
      </main>
      <ChatPanel activeFile={active} openFiles={tabs.map((t) => t.path)} pendingSelection={selection} clearSelection={() => setSelection(null)}
        onFilesChanged={reloadFromDisk} onReview={showReview} pendingVersion={pendingVersion} focusSignal={chatFocus} />
      <footer className="status">
        <span title={root}>{root.split(/[\\/]/).pop()}</span>
        <span className="spacer" />
        <button className="linklike" onClick={() => api.reindex()} title="Re-index codebase">
          {index.state === "indexing" ? "Indexing…" : index.state === "error" ? `Index error: ${index.message}` : `Indexed ${index.files} files · ${index.chunks} chunks`}
        </button>
        <button className="linklike" onClick={() => setTabEnabled((v) => !v)} aria-pressed={tabEnabled}>Tab: {tabEnabled ? "on" : "off"}</button>
        <button className="linklike" onClick={() => setSettingsOpen(true)}>{settings ? (settings.hasKey || settings.envKey ? settings.model : "⚠ No API key") : ""}</button>
      </footer>
      {quickOpen && <QuickOpen onClose={() => setQuickOpen(false)} onPick={(p) => { setQuickOpen(false); openFile(p); }} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function Explorer({ root, version, active, onOpen, onError }: { root: string; version: number; active: string | null; onOpen: (p: string) => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState<Set<string>>(new Set([""]));
  const [children, setChildren] = useState<Record<string, Entry[]>>({});
  const load = useCallback(async (dir: string) => {
    try { const list = await api.list(dir || "."); setChildren((c) => ({ ...c, [dir]: list })); } catch (e) { onError((e as Error).message); }
  }, [onError]);
  useEffect(() => { for (const d of open) load(d); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (d: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(d)) n.delete(d); else { n.add(d); load(d); }
    return n;
  });
  const [creating, setCreating] = useState<string | null>(null);
  async function newFile(name: string) {
    setCreating(null);
    if (!name.trim()) return;
    try { await api.write(name.trim(), ""); load(name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : ""); onOpen(name.trim()); } catch (e) { onError((e as Error).message); }
  }
  const render = (dir: string, depth: number): JSX.Element[] => (children[dir] ?? []).flatMap((e) => [
    <button key={e.path} className={`tree-item${active === e.path ? " active" : ""}`} style={{ paddingLeft: 8 + depth * 12 }}
      onClick={() => (e.dir ? toggle(e.path) : onOpen(e.path))} aria-expanded={e.dir ? open.has(e.path) : undefined} aria-label={e.name}>
      <span className="twisty" aria-hidden>{e.dir ? (open.has(e.path) ? "▾" : "▸") : ""}</span>{e.name}
    </button>,
    ...(e.dir && open.has(e.path) ? render(e.path, depth + 1) : []),
  ]);
  return (
    <div className="explorer">
      <div className="side-head"><span title={root}>{root.split(/[\\/]/).pop()?.toUpperCase()}</span><span className="spacer" />
        <button className="btn ghost small" onClick={() => setCreating("")} title="New file" aria-label="New file">＋</button>
        <button className="btn ghost small" onClick={() => { for (const d of open) load(d); }} title="Refresh" aria-label="Refresh">⟳</button></div>
      {creating !== null && (
        <input className="field" autoFocus placeholder="path/to/new-file.ts" aria-label="New file path" value={creating} style={{ margin: "0 8px 6px", width: "auto" }}
          onChange={(e) => setCreating(e.target.value)} onBlur={() => setCreating(null)}
          onKeyDown={(e) => { if (e.key === "Enter") newFile(creating); if (e.key === "Escape") setCreating(null); }} />
      )}
      <div className="tree" role="tree">{render("", 0)}</div>
    </div>
  );
}

function SearchPanel({ onOpen }: { onOpen: (p: string, line?: number) => void }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ hits: GrepHit[]; truncated: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    if (!q.trim()) return;
    try { setErr(null); setRes(await api.grep(q, { fixed: true })); } catch (e) { setErr((e as Error).message); }
  }
  const byFile = new Map<string, GrepHit[]>();
  for (const h of res?.hits ?? []) byFile.set(h.path, [...(byFile.get(h.path) ?? []), h]);
  return (
    <div className="search-panel">
      <div className="side-head">SEARCH</div>
      <input className="field" placeholder="Search text (Enter)" value={q} autoFocus aria-label="Search text"
        onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
      {err && <div className="error">{err}</div>}
      {res && <div className="muted pad">{res.hits.length}{res.truncated ? "+" : ""} results in {byFile.size} files</div>}
      <div className="tree">
        {[...byFile].map(([f, hits]) => (
          <div key={f}>
            <div className="hit-file">{f}</div>
            {hits.map((h) => (
              <button key={h.line} className="hit" onClick={() => onOpen(f, h.line)}><span className="muted">{h.line}</span> {h.text.trim()}</button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function QuickOpen({ onClose, onPick }: { onClose: () => void; onPick: (p: string) => void }) {
  const [q, setQ] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const [resultsFor, setResultsFor] = useState<string | null>(null);
  useEffect(() => { let live = true; api.searchFiles(q).then((f) => { if (live) { setFiles(f); setSel(0); setResultsFor(q); } }); return () => { live = false; }; }, [q]);
  // Enter right after typing: wait for this query's results instead of picking stale ones
  async function pickCurrent() {
    if (resultsFor === q) { if (files[sel]) onPick(files[sel]); return; }
    const f = await api.searchFiles(q);
    if (f[0]) onPick(f[0]);
  }
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Go to file" onMouseDown={(e) => e.stopPropagation()}>
        <input autoFocus className="field" placeholder="Search files by name" value={q} aria-label="File name"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, files.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === "Enter") pickCurrent();
          }} />
        <div className="palette-list" role="listbox">
          {files.slice(0, 30).map((f, i) => (
            <button key={f} role="option" aria-selected={i === sel} className={i === sel ? "on" : ""} onClick={() => onPick(f)}>
              <b>{f.split("/").pop()}</b> <span className="muted">{f}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { api.getSettings().then((x) => { setS(x); setModel(x.model); }); }, []);
  async function save() {
    try { await api.setSettings({ model, ...(key ? { apiKey: key } : {}) }); setMsg("Saved"); setKey(""); setS(await api.getSettings()); }
    catch (e) { setMsg((e as Error).message); }
  }
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" role="dialog" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <label>Anthropic API key
          <input className="field" type="password" placeholder={s?.hasKey ? "•••••••• (saved — enter a new one to replace)" : s?.envKey ? "Using ANTHROPIC_API_KEY from the environment" : "sk-ant-…"}
            value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        <p className="muted">Stored encrypted with your OS keychain (Electron safeStorage). Never sent anywhere except api.anthropic.com.</p>
        <label>Model
          <input className="field" value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        {msg && <div className="muted" role="status">{msg}</div>}
        <div className="row">
          {s?.hasKey && <button className="btn" onClick={async () => { await api.setSettings({ apiKey: null }); setS(await api.getSettings()); setMsg("Key removed"); }}>Remove key</button>}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

let termSeq = 0;
function Terminal() {
  const [lines, setLines] = useState<string>("");
  const [cmd, setCmd] = useState("");
  const [running, setRunning] = useState<string | null>(null);
  const out = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const a = api.onTermData(({ data }) => setLines((l) => (l + data).slice(-200_000)));
    const b = api.onTermExit(({ id, code }) => { setLines((l) => `${l}\n[exit ${code}]\n`); setRunning((r) => (r === id ? null : r)); });
    return () => { a(); b(); };
  }, []);
  useEffect(() => { out.current?.scrollTo({ top: out.current.scrollHeight }); }, [lines]);
  async function run() {
    if (!cmd.trim() || running) return;
    const id = `t${++termSeq}`;
    setLines((l) => `${l}> ${cmd}\n`);
    setRunning(id); setCmd("");
    try { await api.termRun(id, cmd); } catch (e) { setLines((l) => `${l}${(e as Error).message}\n`); setRunning(null); }
  }
  return (
    <section className="terminal" aria-label="Terminal">
      <pre ref={out}>{lines || "Run a command in the project folder.\n"}</pre>
      <div className="term-input">
        <span>&gt;</span>
        <input className="field" aria-label="Terminal command" value={cmd} onChange={(e) => setCmd(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} placeholder={running ? "Running…" : "e.g. npm test"} />
        {running && <button className="btn small" onClick={() => api.termKill(running)}>Stop</button>}
        <button className="btn small ghost" onClick={() => setLines("")}>Clear</button>
      </div>
    </section>
  );
}
