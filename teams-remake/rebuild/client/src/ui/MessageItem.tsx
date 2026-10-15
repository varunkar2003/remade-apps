import { useMutation } from "@apollo/client";
import { Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, Tooltip } from "@fluentui/react-components";
import { CallRegular, DeleteRegular, DocumentRegular, EditRegular, MoreHorizontalRegular, PersonAddRegular } from "@fluentui/react-icons";
import { useState } from "react";
import { fileUrl } from "../apollo";
import { DELETE, EDIT, REACT, type Message } from "../gql";
import { PersonAvatar, RichText, formatSize, fullTime, timeLabel } from "./common";

const QUICK = ["👍", "❤️", "😂", "😮", "😢", "🎉"];

export function SystemMessage({ m }: { m: Message }) {
  const icon = m.messageType === "Event/Call" ? <CallRegular /> : <PersonAddRegular />;
  return <div className="system-msg">{icon}<span>{m.content}</span><span className="muted">{timeLabel(m.createdAt)}</span></div>;
}

export function MessageItem({ m, me, compact, highlight }: { m: Message; me: string; compact?: boolean; highlight?: boolean }) {
  const mine = m.from?.mri === me;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [react] = useMutation(REACT);
  const [edit] = useMutation(EDIT);
  const [del] = useMutation(DELETE);

  if (m.messageType !== "Text") return <SystemMessage m={m} />;

  const toggle = (emoji: string) => react({ variables: { messageId: m.id, emoji } });
  const saveEdit = async () => {
    if (draft.trim()) await edit({ variables: { id: m.id, content: draft.trim() } });
    setEditing(false);
  };

  return (
    <div className={`msg${compact ? " msg-compact" : ""}${mine ? " msg-mine" : ""}${highlight ? " msg-highlight" : ""}`} id={`msg-${m.id}`}>
      <div className="msg-avatar">{!compact && m.from && <PersonAvatar user={m.from} size={32} />}</div>
      <div className="msg-body">
        {!compact && (
          <div className="msg-head">
            <span className="msg-author">{m.from?.displayName ?? "Unknown"}</span>
            <time className="muted" title={fullTime(m.createdAt)}>{timeLabel(m.createdAt)}</time>
            {m.editedAt && !m.deleted && <span className="muted">Edited</span>}
          </div>
        )}
        {m.deleted ? <div className="msg-deleted muted">This message has been deleted.</div> : editing ? (
          <div className="msg-edit">
            <textarea value={draft} autoFocus onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit(); } if (e.key === "Escape") setEditing(false); }} />
            <div><Button size="small" appearance="primary" onClick={saveEdit}>Save</Button> <Button size="small" onClick={() => setEditing(false)}>Cancel</Button></div>
          </div>
        ) : (
          <>
            {m.subject && <div className="msg-subject">{m.subject}</div>}
            {m.content && <div className="msg-content"><RichText content={m.content} me={me} /></div>}
            {m.files.length > 0 && (
              <div className="msg-files">
                {m.files.map((f) => f.mime.startsWith("image/") ? (
                  <a key={f.id} href={fileUrl(f.url)} target="_blank" rel="noreferrer"><img className="msg-image" src={fileUrl(f.url)} alt={f.name} /></a>
                ) : (
                  <a key={f.id} className="file-card" href={fileUrl(f.url)} download={f.name}>
                    <DocumentRegular fontSize={24} /><span><strong>{f.name}</strong><br /><span className="muted">{formatSize(f.size)}</span></span>
                  </a>
                ))}
              </div>
            )}
          </>
        )}
        {m.reactions.length > 0 && !m.deleted && (
          <div className="reactions">
            {m.reactions.map((r) => (
              <Tooltip key={r.emoji} relationship="description" content={r.users.map((u) => u.displayName).join(", ")}>
                <button className={`reaction${r.reactedByMe ? " reaction-mine" : ""}`} onClick={() => toggle(r.emoji)}
                  aria-pressed={r.reactedByMe}>{r.emoji} {r.count}</button>
              </Tooltip>
            ))}
          </div>
        )}
      </div>
      {!m.deleted && !editing && (
        <div className="msg-actions" role="toolbar" aria-label="Message actions">
          {QUICK.map((e) => <button key={e} className="quick-react" aria-label={`React ${e}`} onClick={() => toggle(e)}>{e}</button>)}
          {mine && (
            <Menu>
              <MenuTrigger disableButtonEnhancement><Button size="small" appearance="subtle" icon={<MoreHorizontalRegular />} aria-label="More options" /></MenuTrigger>
              <MenuPopover><MenuList>
                <MenuItem icon={<EditRegular />} onClick={() => { setDraft(m.content); setEditing(true); }}>Edit</MenuItem>
                <MenuItem icon={<DeleteRegular />} onClick={() => del({ variables: { id: m.id } })}>Delete</MenuItem>
              </MenuList></MenuPopover>
            </Menu>
          )}
        </div>
      )}
    </div>
  );
}
