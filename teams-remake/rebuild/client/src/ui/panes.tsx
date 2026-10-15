// Left-rail list panes: Chat, Teams, Activity, Calls.
import { useMutation, useQuery } from "@apollo/client";
import { Button, CounterBadge, Spinner, Tooltip } from "@fluentui/react-components";
import {
  AddRegular, ChevronDownRegular, ChevronRightRegular, ComposeRegular, PeopleTeamAddRegular, VideoRegular,
} from "@fluentui/react-icons";
import { useState } from "react";
import { joinCall, useCall } from "../calls";
import { ACTIVE_CALLS, ACTIVITY, CHATS, CREATE_CHAT, MARK_ACTIVITY_READ, TEAMS, type Thread } from "../gql";
import { PersonAvatar, threadTitle, timeLabel, toPlain } from "./common";
import { NameDialog, PeoplePicker, useCreateChannel, useCreateTeam } from "./dialogs";

export type Nav = { threadId: string | null; focusMessage?: string | null };

function preview(t: Thread, me: string) {
  const m = t.lastMessage;
  if (!m) return "No messages yet";
  if (m.deleted) return "Message deleted";
  const text = toPlain(m.content) || "Sent a file";
  if (m.messageType !== "Text") return text;
  return m.from?.mri === me ? `You: ${text}` : t.members.length > 2 ? `${m.from?.displayName.split(" ")[0]}: ${text}` : text;
}

export function ChatPane({ me, nav, onNav }: { me: string; nav: Nav; onNav: (n: Nav) => void }) {
  const { data, loading } = useQuery(CHATS);
  const [createChat] = useMutation(CREATE_CHAT, { refetchQueries: ["Chats"] });
  const [picking, setPicking] = useState(false);
  const chats: Thread[] = data?.chats ?? [];
  return (
    <>
      <div className="pane-head">
        <h2>Chat</h2>
        <Tooltip content="New chat" relationship="label"><Button appearance="subtle" icon={<ComposeRegular />} onClick={() => setPicking(true)} /></Tooltip>
      </div>
      <nav className="pane-list" aria-label="Chats">
        {loading && <Spinner size="small" />}
        {!loading && !chats.length && <div className="pane-empty muted">No chats yet. Start one with the compose button.</div>}
        {chats.map((t) => {
          const others = t.members.filter((m) => m.mri !== me);
          return (
            <button key={t.id} className={`list-item${nav.threadId === t.id ? " selected" : ""}${t.unreadCount ? " unread" : ""}`}
              onClick={() => onNav({ threadId: t.id })}>
              {others.length === 1 ? <PersonAvatar user={others[0]} size={32} />
                : <PersonAvatar user={{ displayName: threadTitle(t, me) }} size={32} presence={false} />}
              <span className="list-text">
                <span className="list-title">{threadTitle(t, me)}</span>
                <span className="list-sub">{preview(t, me)}</span>
              </span>
              <span className="list-meta">
                {t.activeCall ? <VideoRegular className="live-call" aria-label="Call in progress" /> : <span className="muted">{timeLabel(t.lastActivityAt)}</span>}
                {t.unreadCount > 0 && <CounterBadge count={t.unreadCount} size="small" color="brand" />}
              </span>
            </button>
          );
        })}
      </nav>
      <PeoplePicker open={picking} title="New chat" action="Start chat" exclude={[me]} withTopic onClose={() => setPicking(false)}
        onPick={async (mris, topic) => {
          const { data } = await createChat({ variables: { memberMris: mris, topic } });
          onNav({ threadId: data.createChat.id });
        }} />
    </>
  );
}

export function TeamsPane({ nav, onNav }: { nav: Nav; onNav: (n: Nav) => void }) {
  const { data, loading } = useQuery(TEAMS);
  const createTeam = useCreateTeam();
  const createChannel = useCreateChannel();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [newTeam, setNewTeam] = useState(false);
  const [channelFor, setChannelFor] = useState<string | null>(null);
  const teams: Thread[] = data?.teams ?? [];
  return (
    <>
      <div className="pane-head">
        <h2>Teams</h2>
        <Tooltip content="Create a team" relationship="label"><Button appearance="subtle" icon={<PeopleTeamAddRegular />} onClick={() => setNewTeam(true)} /></Tooltip>
      </div>
      <nav className="pane-list" aria-label="Teams">
        {loading && <Spinner size="small" />}
        {!loading && !teams.length && <div className="pane-empty muted">You're not in any teams yet. Create one, or ask an owner to add you.</div>}
        {teams.map((team) => {
          const open = !collapsed.has(team.id);
          return (
            <div key={team.id} className="team">
              <div className="team-row">
                <button className="team-toggle" aria-expanded={open} onClick={() => setCollapsed((s) => {
                  const n = new Set(s); open ? n.add(team.id) : n.delete(team.id); return n;
                })}>
                  {open ? <ChevronDownRegular /> : <ChevronRightRegular />}
                  <span className="team-tile" aria-hidden>{team.topic?.[0]?.toUpperCase()}</span>
                  <span className="list-title">{team.topic}</span>
                </button>
                {team.myRole === "Admin" && (
                  <Tooltip content="Add channel" relationship="label">
                    <Button size="small" appearance="subtle" icon={<AddRegular />} onClick={() => setChannelFor(team.id)} />
                  </Tooltip>
                )}
              </div>
              {open && team.channels?.map((c) => (
                <button key={c.id} className={`channel-item${nav.threadId === c.id ? " selected" : ""}${c.unreadCount ? " unread" : ""}`}
                  onClick={() => onNav({ threadId: c.id })}>
                  <span>{c.topic}</span>
                  {c.activeCall && <VideoRegular className="live-call" aria-label="Meeting in progress" />}
                </button>
              ))}
            </div>
          );
        })}
      </nav>
      <NameDialog open={newTeam} title="Create a team" label="Team name" action="Create" withDescription
        onClose={() => setNewTeam(false)}
        onSubmit={async (name, d) => {
          const { data } = await createTeam(name, d);
          onNav({ threadId: data.createTeam.channels[0].id });
        }} />
      <NameDialog open={!!channelFor} title="Add a channel" label="Channel name" action="Add" withDescription
        onClose={() => setChannelFor(null)}
        onSubmit={async (name, d) => {
          const { data } = await createChannel(channelFor!, name, d);
          onNav({ threadId: data.createChannel.id });
        }} />
    </>
  );
}

const KIND_LABEL: Record<string, string> = { mention: "mentioned you", reply: "replied", reaction: "reacted to your message" };

export function ActivityPane({ onNav }: { onNav: (n: Nav) => void }) {
  const { data, loading } = useQuery(ACTIVITY);
  const [markAll] = useMutation(MARK_ACTIVITY_READ, { refetchQueries: ["Activity"] });
  const items = data?.activity ?? [];
  return (
    <>
      <div className="pane-head">
        <h2>Activity</h2>
        {items.some((a: any) => !a.read) && <Button size="small" appearance="subtle" onClick={() => markAll()}>Mark all read</Button>}
      </div>
      <nav className="pane-list" aria-label="Activity">
        {loading && <Spinner size="small" />}
        {!loading && !items.length && <div className="pane-empty muted">Mentions, replies and reactions will show up here.</div>}
        {items.map((a: any) => (
          <button key={a.id} className={`list-item activity${a.read ? "" : " unread"}`}
            onClick={() => onNav({ threadId: a.thread.id, focusMessage: a.messageId })}>
            <PersonAvatar user={a.actor} size={32} />
            <span className="list-text">
              <span className="list-title">{a.actor.displayName} {KIND_LABEL[a.kind] ?? a.kind}</span>
              <span className="list-sub">{toPlain(a.preview ?? "")}</span>
              <span className="list-sub muted">
                {a.thread.type === "channel" ? `${a.thread.team?.topic} › ${a.thread.topic}` : "Chat"} · {timeLabel(a.createdAt)}
              </span>
            </span>
          </button>
        ))}
      </nav>
    </>
  );
}

export function CallsPane({ me, onNav }: { me: string; onNav: (n: Nav) => void }) {
  const { data } = useQuery(ACTIVE_CALLS, { pollInterval: 5000 });
  const { data: chats } = useQuery(CHATS);
  const call = useCall();
  const active = data?.activeCalls ?? [];
  const recent: Thread[] = (chats?.chats ?? []).slice(0, 15);
  return (
    <>
      <div className="pane-head"><h2>Calls</h2></div>
      <nav className="pane-list" aria-label="Calls">
        <h3 className="pane-section">In progress</h3>
        {!active.length && <div className="pane-empty muted">No calls in progress.</div>}
        {active.map((c: any) => (
          <div key={c.id} className="list-item">
            <span className="list-text">
              <span className="list-title">{c.participants.map((p: any) => p.displayName).join(", ") || "Waiting…"}</span>
              <span className="list-sub muted">Started {timeLabel(c.startedAt)}</span>
            </span>
            {call.call?.id === c.id ? <span className="muted">You're in this call</span> : (
              <Button size="small" appearance="primary" disabled={!!call.call} onClick={() => { onNav({ threadId: c.threadId }); joinCall(c.id, true); }}>Join</Button>
            )}
          </div>
        ))}
        <h3 className="pane-section">Speed dial</h3>
        {recent.map((t) => (
          <button key={t.id} className="list-item" onClick={() => onNav({ threadId: t.id })}>
            <PersonAvatar user={{ displayName: threadTitle(t, me), presence: t.members.find((m) => m.mri !== me)?.presence }} size={28}
              presence={t.members.length === 2} />
            <span className="list-text"><span className="list-title">{threadTitle(t, me)}</span></span>
          </button>
        ))}
      </nav>
    </>
  );
}
