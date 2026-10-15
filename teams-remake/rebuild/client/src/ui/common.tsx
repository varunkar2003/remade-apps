import { Avatar, type AvatarProps, type PresenceBadgeStatus } from "@fluentui/react-components";
import { Fragment, type ReactNode } from "react";
import type { Thread, User } from "../gql";

type Status = PresenceBadgeStatus;
const STATUS: Record<string, Status> = {
  Available: "available", Busy: "busy", InACall: "busy", DoNotDisturb: "do-not-disturb",
  BeRightBack: "away", Away: "away", Offline: "offline",
};
export const PRESENCE_LABEL: Record<string, string> = {
  Available: "Available", Busy: "Busy", InACall: "In a call", DoNotDisturb: "Do not disturb",
  BeRightBack: "Be right back", Away: "Appear away", Offline: "Offline",
};

export function PersonAvatar({ user, size = 32, presence = true }: {
  user: Pick<User, "displayName"> & Partial<Pick<User, "presence">>; size?: AvatarProps["size"]; presence?: boolean;
}) {
  return (
    <Avatar name={user.displayName} size={size} color="colorful"
      badge={presence && user.presence ? { status: STATUS[user.presence] ?? "unknown" } : undefined} />
  );
}

export function threadTitle(t: Pick<Thread, "type" | "topic" | "members">, me: string) {
  if (t.topic) return t.topic;
  const others = t.members.filter((m) => m.mri !== me);
  if (!others.length) return "Just you";
  return others.map((m) => (others.length > 1 ? m.displayName.split(" ")[0] : m.displayName)).join(", ");
}

export function timeLabel(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const diff = (today.getTime() - ts) / 86400000;
  if (diff < 6) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "numeric", day: "numeric" });
}
export const fullTime = (ts: number) =>
  new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export const formatSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

/** Message content → plain text (previews, notifications). */
export const toPlain = (content: string) =>
  content.replace(/<at id="[^"]*">([^<]*)<\/at>/g, "@$1").replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();

// ---------- rich text ----------
// Stored format: text with Teams-style <at id="MRI">Name</at> mention tags plus light markdown
// (**bold**, _italic_, `code`, ```blocks```, links). Rendered as React nodes — never as HTML.
const INLINE = /(\*\*[^*\n]+\*\*|_[^_\n]+_|`[^`\n]+`|https?:\/\/[^\s<]+)/g;

function inline(text: string, key: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const k = `${key}-${i}`;
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={k}>{part.slice(2, -2)}</strong>;
    if (/^_[^_]+_$/.test(part)) return <em key={k}>{part.slice(1, -1)}</em>;
    if (/^`[^`]+`$/.test(part)) return <code key={k}>{part.slice(1, -1)}</code>;
    if (/^https?:\/\//.test(part)) return <a key={k} href={part} target="_blank" rel="noreferrer noopener">{part}</a>;
    return part.split("\n").map((line, j) => <Fragment key={`${k}-${j}`}>{j > 0 && <br />}{line}</Fragment>);
  });
}

export function RichText({ content, me }: { content: string; me: string }) {
  const blocks = content.split(/```\n?([\s\S]*?)```/g);
  return (
    <>
      {blocks.map((block, bi) =>
        bi % 2 === 1 ? <pre key={bi} className="code-block">{block}</pre> : (
          <Fragment key={bi}>
            {block.split(/(<at id="[^"]*">[^<]*<\/at>)/g).map((seg, si) => {
              const m = seg.match(/^<at id="([^"]*)">([^<]*)<\/at>$/);
              if (m) return <span key={si} className={`mention${m[1] === me ? " mention-me" : ""}`}>{m[2]}</span>;
              return <Fragment key={si}>{inline(seg, `${bi}-${si}`)}</Fragment>;
            })}
          </Fragment>
        ))}
    </>
  );
}
