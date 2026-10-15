// AI pane: Agent / Ask modes, streamed text, tool-call cards, command approvals,
// todo list, @file mentions and the "files changed" review bar.
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type AgentEvent } from "./api";
import type { Selection } from "./Editor";

type Item =
  | { kind: "user"; text: string; chips: string[] }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: any; status: "running" | "ok" | "error"; summary?: string }
  | { kind: "approval"; id: string; command: string; explanation?: string; decided?: boolean | null }
  | { kind: "todos"; todos: { content: string; status: string }[] }
  | { kind: "error"; text: string };

const TOOL_LABEL: Record<string, string> = {
  read_file: "Read", list_dir: "List", grep_search: "Grep", file_search: "Find file", codebase_search: "Search codebase",
  edit_file: "Edit", write_file: "Write", delete_file: "Delete", run_terminal_command: "Terminal", todo_write: "Todos",
};

// ---- minimal safe markdown: fenced code, inline code, bold, links → React nodes (no HTML injection)
function inline(text: string, key: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|https?:\/\/[^\s)]+)/g).map((p, i) => {
    if (/^`[^`]+`$/.test(p)) return <code key={`${key}${i}`}>{p.slice(1, -1)}</code>;
    if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={`${key}${i}`}>{p.slice(2, -2)}</strong>;
    if (/^https?:\/\//.test(p)) return <a key={`${key}${i}`} href={p} target="_blank" rel="noreferrer">{p}</a>;
    return <Fragment key={`${key}${i}`}>{p}</Fragment>;
  });
}
export function Markdown({ text }: { text: string }) {
  const parts = text.split(/```[\w+-]*\n?([\s\S]*?)(?:```|$)/g);
  return (
    <div className="md">
      {parts.map((p, i) => i % 2 === 1 ? <pre key={i}><code>{p.replace(/\n$/, "")}</code></pre> : (
        p.split(/\n{2,}/).filter((x) => x.trim()).map((para, j) => (
          <p key={`${i}-${j}`}>{para.split("\n").map((line, k) => <Fragment key={k}>{k > 0 && <br />}{inline(line.replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/, "• "), `${i}-${j}-${k}`)}</Fragment>)}</p>
        ))
      ))}
    </div>
  );
}

let sessionCounter = 0;
const newSessionId = () => `chat-${Date.now()}-${++sessionCounter}`;

export function ChatPanel(props: {
  activeFile: string | null; openFiles: string[];
  pendingSelection: Selection | null; clearSelection: () => void;
  onFilesChanged: (paths: string[]) => void; onReview: (sid: string, path: string) => void;
  pendingVersion: number; focusSignal: number;
}) {
  const [sid, setSid] = useState(newSessionId);
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"agent" | "ask">("agent");
  const [busy, setBusy] = useState(false);
  const [mentions, setMentions] = useState<string[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionHits, setMentionHits] = useState<string[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const sidRef = useRef(sid);
  sidRef.current = sid;

  const refreshPending = () => api.pending(sidRef.current).then(setPending).catch(() => {});
  useEffect(() => { refreshPending(); }, [props.pendingVersion, sid]);
  useEffect(() => { if (props.focusSignal) box.current?.focus(); }, [props.focusSignal]);

  useEffect(() => api.onAgentEvent(({ sessionId, event }) => {
    if (sessionId !== sidRef.current) return;
    apply(event);
  }), []);

  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [items]);

  useEffect(() => {
    if (mentionQuery === null) return setMentionHits([]);
    let live = true;
    api.searchFiles(mentionQuery || "").then((r) => live && setMentionHits(r.slice(0, 8))).catch(() => {});
    return () => { live = false; };
  }, [mentionQuery]);

  function apply(e: AgentEvent) {
    setItems((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      switch (e.type) {
        case "text":
          if (last?.kind === "text") next[next.length - 1] = { ...last, text: last.text + e.delta };
          else next.push({ kind: "text", text: e.delta });
          break;
        case "tool_start":
          if (e.name !== "todo_write") next.push({ kind: "tool", id: e.id, name: e.name, input: e.input, status: "running" });
          break;
        case "tool_end": {
          const i = next.findIndex((x) => x.kind === "tool" && x.id === e.id);
          if (i >= 0) next[i] = { ...(next[i] as any), status: e.ok ? "ok" : "error", summary: e.summary };
          next.forEach((x, j) => { if (x.kind === "approval" && x.id === e.id && x.decided === undefined) next[j] = { ...x, decided: null }; });
          break;
        }
        case "approval":
          next.push({ kind: "approval", id: e.id, command: e.command, explanation: e.explanation });
          break;
        case "todos": {
          const i = next.findIndex((x) => x.kind === "todos");
          if (i >= 0) next.splice(i, 1);
          next.push({ kind: "todos", todos: e.todos });
          break;
        }
        case "error":
          next.push({ kind: "error", text: e.message });
          break;
      }
      return next;
    });
    if (e.type === "file_changed") { props.onFilesChanged([e.path]); refreshPending(); }
    if (e.type === "done") { setBusy(false); refreshPending(); }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const sel = props.pendingSelection;
    const chips = [...mentions.map((m) => `@${m}`), ...(sel ? [`${sel.path}:${sel.start}-${sel.end}`] : [])];
    setItems((p) => [...p, { kind: "user", text, chips }]);
    setInput(""); setMentions([]); props.clearSelection();
    setBusy(true);
    try {
      await api.chat({ sessionId: sid, mode, text, context: {
        activeFile: props.activeFile ?? undefined, openFiles: props.openFiles, mentionedFiles: mentions,
        selection: sel && sel.text ? sel : undefined } });
    } catch (e) {
      setBusy(false);
      setItems((p) => [...p, { kind: "error", text: (e as Error).message }]);
    }
  }

  function decide(id: string, ok: boolean) {
    api.approve(sid, id, ok);
    setItems((p) => p.map((x) => (x.kind === "approval" && x.id === id ? { ...x, decided: ok } : x)));
  }

  async function newChat() {
    if (busy) await api.stop(sid);
    api.resetChat(sid);
    setSid(newSessionId()); setItems([]); setBusy(false); setPending([]);
  }

  function onInput(v: string) {
    setInput(v);
    const caret = box.current?.selectionStart ?? v.length;
    const m = v.slice(0, caret).match(/(?:^|\s)@([\w./-]*)$/);
    setMentionQuery(m ? m[1] : null);
  }
  function pickMention(path: string) {
    const caret = box.current?.selectionStart ?? input.length;
    const before = input.slice(0, caret).replace(/@[\w./-]*$/, "");
    setInput(before + input.slice(caret));
    setMentions((m) => (m.includes(path) ? m : [...m, path]));
    setMentionQuery(null);
    box.current?.focus();
  }

  async function acceptAll() { for (const p of pending) await api.accept(sid, p); refreshPending(); }
  async function rejectAll() { for (const p of pending) await api.reject(sid, p); props.onFilesChanged(pending); refreshPending(); }

  return (
    <aside className="chat" aria-label="AI chat">
      <div className="chat-head">
        <div className="mode-switch" role="radiogroup" aria-label="Mode">
          {(["agent", "ask"] as const).map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
              {m === "agent" ? "Agent" : "Ask"}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className="btn ghost" onClick={newChat} title="New chat">＋ New chat</button>
      </div>

      <div className="chat-list" ref={list}>
        {!items.length && (
          <div className="chat-empty muted">
            <p><b>Agent</b> reads, searches, edits files and runs commands (with your approval).</p>
            <p><b>Ask</b> answers questions without changing anything.</p>
            <p>Type <code>@</code> to attach a file. Select code and press <code>Ctrl+L</code> to add it here.</p>
          </div>
        )}
        {items.map((it, i) => {
          switch (it.kind) {
            case "user": return (
              <div key={i} className="msg-user">{it.chips.length > 0 && <div className="chips">{it.chips.map((c) => <span key={c} className="chip">{c}</span>)}</div>}{it.text}</div>
            );
            case "text": return <div key={i} className="msg-ai"><Markdown text={it.text} /></div>;
            case "tool": return (
              <details key={i} className={`tool tool-${it.status}`}>
                <summary>
                  <span className="tool-dot" aria-hidden />
                  <b>{TOOL_LABEL[it.name] ?? it.name}</b> <span className="tool-sum">{it.summary ?? describe(it.name, it.input)}</span>
                </summary>
                <pre>{JSON.stringify(it.input, null, 2).slice(0, 4000)}</pre>
              </details>
            );
            case "approval": return (
              <div key={i} className="approval" role="group" aria-label="Command approval">
                <div className="muted">{it.explanation ?? "The agent wants to run:"}</div>
                <pre>{it.command}</pre>
                {it.decided === undefined ? (
                  <div className="row"><button className="btn" onClick={() => decide(it.id, false)}>Skip</button>
                    <button className="btn primary" onClick={() => decide(it.id, true)}>Run</button></div>
                ) : <div className="muted">{it.decided ? "Approved" : it.decided === false ? "Skipped" : "Cancelled"}</div>}
              </div>
            );
            case "todos": return (
              <div key={i} className="todos" aria-label="Agent plan">
                {it.todos.map((t, j) => <div key={j} className={`todo todo-${t.status}`}>{t.status === "completed" ? "☑" : t.status === "in_progress" ? "◐" : "☐"} {t.content}</div>)}
              </div>
            );
            case "error": return <div key={i} className="error" role="alert">{it.text}</div>;
          }
        })}
        {busy && <div className="thinking muted">Working…</div>}
      </div>

      {pending.length > 0 && (
        <div className="review-bar" aria-label="Files changed">
          <div className="review-title">{pending.length} file{pending.length > 1 ? "s" : ""} changed
            <span className="spacer" /><button className="btn" onClick={rejectAll}>Reject all</button><button className="btn primary" onClick={acceptAll}>Accept all</button></div>
          {pending.map((p) => (
            <div key={p} className="review-file">
              <button className="linklike" onClick={() => props.onReview(sid, p)}>{p}</button>
              <span className="spacer" />
              <button className="btn small" aria-label={`Reject ${p}`} onClick={async () => { await api.reject(sid, p); props.onFilesChanged([p]); refreshPending(); }}>✕</button>
              <button className="btn small primary" aria-label={`Accept ${p}`} onClick={async () => { await api.accept(sid, p); refreshPending(); }}>✓</button>
            </div>
          ))}
        </div>
      )}

      <div className="composer">
        {(mentions.length > 0 || props.pendingSelection) && (
          <div className="chips">
            {mentions.map((m) => <span key={m} className="chip">@{m} <button aria-label={`Remove ${m}`} onClick={() => setMentions((x) => x.filter((y) => y !== m))}>✕</button></span>)}
            {props.pendingSelection && <span className="chip">{props.pendingSelection.path}:{props.pendingSelection.start}-{props.pendingSelection.end} <button aria-label="Remove selection" onClick={props.clearSelection}>✕</button></span>}
          </div>
        )}
        {mentionHits.length > 0 && (
          <div className="mention-pop" role="listbox">
            {mentionHits.map((f) => <button key={f} onMouseDown={(e) => { e.preventDefault(); pickMention(f); }}>{f}</button>)}
          </div>
        )}
        <textarea ref={box} aria-label="Message the AI" placeholder={mode === "agent" ? "Ask the agent to build, fix or change something…" : "Ask a question about your code…"}
          value={input} onChange={(e) => onInput(e.target.value)}
          onKeyDown={(e) => {
            if (mentionHits.length && (e.key === "Enter" || e.key === "Tab")) { e.preventDefault(); pickMention(mentionHits[0]); return; }
            if (e.key === "Escape") setMentionQuery(null);
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }} />
        <div className="composer-row">
          <span className="muted">{mode === "agent" ? "Agent" : "Ask"} · Enter to send</span>
          <span className="spacer" />
          {busy ? <button className="btn" onClick={() => api.stop(sid)}>Stop</button>
            : <button className="btn primary" onClick={send} disabled={!input.trim()}>Send</button>}
        </div>
      </div>
    </aside>
  );
}

function describe(name: string, input: any) {
  if (!input) return "";
  return input.path ?? input.query ?? input.pattern ?? input.command ?? "";
}
