import { useMutation } from "@apollo/client";
import {
  Button, Input, Popover, PopoverSurface, PopoverTrigger, Spinner, Tooltip,
} from "@fluentui/react-components";
import { AttachRegular, DismissRegular, DocumentRegular, EmojiRegular, SendRegular, TextEditStyleRegular } from "@fluentui/react-icons";
import { useRef, useState, type KeyboardEvent } from "react";
import { getToken } from "../apollo";
import { SEND, TYPING, type FileRef, type User } from "../gql";
import { PersonAvatar, formatSize } from "./common";

const EMOJI = ["👍", "❤️", "😂", "😮", "😢", "🎉", "🙏", "🔥", "👀", "✅", "🚀", "💯"];

export function Composer({ threadId, parentId, members, me, placeholder, withSubject, autoFocus, onSent }: {
  threadId: string; parentId?: string; members: User[]; me: string; placeholder: string;
  withSubject?: boolean; autoFocus?: boolean; onSent?: () => void;
}) {
  const [text, setText] = useState("");
  const [subject, setSubject] = useState("");
  const [showSubject, setShowSubject] = useState(false);
  const [mentions, setMentions] = useState<{ mri: string; name: string }[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [files, setFiles] = useState<FileRef[]>([]);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);
  const [send, { loading }] = useMutation(SEND);
  const [typing] = useMutation(TYPING);

  const candidates = query === null ? [] : members
    .filter((m) => m.mri !== me && m.displayName.toLowerCase().includes(query.toLowerCase())).slice(0, 6);

  function onChange(v: string) {
    setText(v);
    const caret = ref.current?.selectionStart ?? v.length;
    const m = v.slice(0, caret).match(/(?:^|\s)@([\w.\- ]{0,30})$/);
    setQuery(m ? m[1] : null);
    if (Date.now() - lastTyping.current > 2500 && v.trim()) {
      lastTyping.current = Date.now();
      typing({ variables: { threadId } }).catch(() => {});
    }
  }

  function pickMention(u: User) {
    const el = ref.current!;
    const caret = el.selectionStart;
    const before = text.slice(0, caret).replace(/@[\w.\- ]{0,30}$/, `@${u.displayName} `);
    setText(before + text.slice(caret));
    setMentions((ms) => (ms.some((m) => m.mri === u.mri) ? ms : [...ms, { mri: u.mri, name: u.displayName }]));
    setQuery(null);
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = before.length; });
  }

  async function upload(list: FileList | null) {
    for (const f of Array.from(list ?? [])) {
      setUploading((n) => n + 1);
      try {
        const body = new FormData();
        body.append("file", f);
        const res = await fetch("/api/files", { method: "POST", body, headers: { authorization: `Bearer ${getToken()}` } });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Upload failed");
        const ref = await res.json();
        setFiles((fs) => [...fs, ref]);
      } catch (e: any) {
        setError(`${f.name}: ${e.message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  async function submit() {
    if ((!text.trim() && !files.length) || loading || uploading) return;
    let content = text.trim();
    const used: string[] = [];
    for (const m of mentions) {
      const token = `@${m.name}`;
      if (content.includes(token)) {
        content = content.replace(token, `<at id="${m.mri}">${m.name}</at>`);
        used.push(m.mri);
      }
    }
    try {
      await send({
        variables: {
          threadId, content, parentId, mentionMris: used, fileIds: files.map((f) => f.id),
          subject: withSubject && showSubject ? subject : undefined,
        },
      });
      setText(""); setSubject(""); setShowSubject(false); setMentions([]); setFiles([]); setError(null);
      onSent?.();
    } catch (e: any) {
      setError(e.message);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (candidates.length && (e.key === "Enter" || e.key === "Tab")) { e.preventDefault(); pickMention(candidates[0]); return; }
    if (e.key === "Escape") setQuery(null);
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  }

  return (
    <div className="composer">
      {candidates.length > 0 && (
        <div className="mention-list" role="listbox" aria-label="Suggestions">
          {candidates.map((u) => (
            <button key={u.mri} className="mention-option" onMouseDown={(e) => { e.preventDefault(); pickMention(u); }}>
              <PersonAvatar user={u} size={24} /> {u.displayName}
            </button>
          ))}
        </div>
      )}
      {withSubject && showSubject && (
        <Input className="composer-subject" placeholder="Add a subject" value={subject}
          onChange={(_, d) => setSubject(d.value)} appearance="underline" />
      )}
      <textarea ref={ref} className="composer-input" rows={1} value={text} placeholder={placeholder}
        autoFocus={autoFocus} aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown}
        onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); upload(e.clipboardData.files); } }} />
      {(files.length > 0 || uploading > 0) && (
        <div className="composer-files">
          {files.map((f) => (
            <span key={f.id} className="file-chip">
              <DocumentRegular /> {f.name} <span className="muted">{formatSize(f.size)}</span>
              <button aria-label={`Remove ${f.name}`} onClick={() => setFiles((fs) => fs.filter((x) => x.id !== f.id))}><DismissRegular /></button>
            </span>
          ))}
          {uploading > 0 && <Spinner size="extra-tiny" label="Uploading…" />}
        </div>
      )}
      {error && <div className="composer-error" role="alert">{error}</div>}
      <div className="composer-bar">
        {withSubject && (
          <Tooltip content="Add a subject" relationship="label">
            <Button appearance="subtle" icon={<TextEditStyleRegular />} onClick={() => setShowSubject((v) => !v)} />
          </Tooltip>
        )}
        <Popover>
          <PopoverTrigger disableButtonEnhancement>
            <Tooltip content="Emoji" relationship="label"><Button appearance="subtle" icon={<EmojiRegular />} /></Tooltip>
          </PopoverTrigger>
          <PopoverSurface className="emoji-grid">
            {EMOJI.map((e) => <button key={e} onClick={() => { setText((t) => t + e); ref.current?.focus(); }}>{e}</button>)}
          </PopoverSurface>
        </Popover>
        <Tooltip content="Attach file" relationship="label">
          <Button appearance="subtle" icon={<AttachRegular />} onClick={() => fileInput.current?.click()} />
        </Tooltip>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
        <span className="composer-hint muted">**bold** _italic_ `code` · Shift+Enter for new line</span>
        <Tooltip content="Send" relationship="label">
          <Button appearance="transparent" className="send-btn" icon={<SendRegular />} onClick={submit}
            disabled={(!text.trim() && !files.length) || loading || uploading > 0} />
        </Tooltip>
      </div>
    </div>
  );
}
