import { useApolloClient, useMutation, useQuery } from "@apollo/client";
import {
  Button, CounterBadge, Input, Menu, MenuDivider, MenuItem, MenuItemRadio, MenuList, MenuPopover, MenuTrigger, Spinner,
} from "@fluentui/react-components";
import {
  AlertFilled, AlertRegular, CallFilled, CallRegular, ChatFilled, ChatRegular, PeopleTeamFilled, PeopleTeamRegular,
  SearchRegular, SignOutRegular,
} from "@fluentui/react-icons";
import { useEffect, useMemo, useState } from "react";
import { setToken, wsClient } from "./apollo";
import { setCallIdentity, useCall } from "./calls";
import { ACTIVITY, CHATS, ME, SET_PRESENCE, TEAMS, THREAD_Q, type Thread } from "./gql";
import { usePush } from "./push";
import { CallStage, IncomingCall } from "./ui/CallStage";
import { PRESENCE_LABEL, PersonAvatar } from "./ui/common";
import { Conversation } from "./ui/Conversation";
import { Login } from "./ui/Login";
import { ActivityPane, CallsPane, ChatPane, TeamsPane, type Nav } from "./ui/panes";
import { SearchView } from "./ui/SearchView";

type AppId = "activity" | "chat" | "teams" | "calls";

export function App() {
  const client = useApolloClient();
  const { data, loading, refetch } = useQuery(ME);
  const me = data?.me;
  if (loading) return <div className="empty full"><Spinner /></div>;
  if (!me) return <Login onSignedIn={() => { client.resetStore(); refetch(); }} />;
  return <Shell me={me} onSignOut={async () => {
    setToken(null);
    wsClient.terminate();
    await client.clearStore();
    refetch();
  }} />;
}

function Shell({ me, onSignOut }: { me: { mri: string; displayName: string; email: string; presence: string }; onSignOut: () => void }) {
  usePush(true);
  useEffect(() => setCallIdentity(me.mri), [me.mri]);
  const [app, setApp] = useState<AppId>("chat");
  const [nav, setNav] = useState<Nav>({ threadId: null });
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const call = useCall();
  const { data: chats } = useQuery(CHATS);
  const { data: teams } = useQuery(TEAMS);
  const { data: activity } = useQuery(ACTIVITY);
  const [setPresence] = useMutation(SET_PRESENCE);
  const { data: callThread } = useQuery(THREAD_Q, { variables: { id: call.threadId }, skip: !call.threadId });

  const chatUnread = (chats?.chats ?? []).reduce((n: number, t: Thread) => n + t.unreadCount, 0);
  const teamUnread = (teams?.teams ?? []).reduce((n: number, t: Thread) => n + t.unreadCount, 0);
  const actUnread = (activity?.activity ?? []).filter((a: any) => !a.read).length;
  const names = useMemo(() => new Map<string, string>((callThread?.thread?.members ?? []).map((m: any) => [m.mri, m.displayName])),
    [callThread]);

  useEffect(() => {
    const total = chatUnread + teamUnread + actUnread;
    document.title = total ? `(${total}) Teams Rebuild` : "Teams Rebuild";
  }, [chatUnread, teamUnread, actUnread]);

  const go = (n: Nav) => { setQuery(null); setNav(n); };
  const goApp = (a: AppId) => { setApp(a); setQuery(null); };
  const apps: { id: AppId; label: string; icon: JSX.Element; active: JSX.Element; badge: number }[] = [
    { id: "activity", label: "Activity", icon: <AlertRegular />, active: <AlertFilled />, badge: actUnread },
    { id: "chat", label: "Chat", icon: <ChatRegular />, active: <ChatFilled />, badge: chatUnread },
    { id: "teams", label: "Teams", icon: <PeopleTeamRegular />, active: <PeopleTeamFilled />, badge: teamUnread },
    { id: "calls", label: "Calls", icon: <CallRegular />, active: <CallFilled />, badge: 0 },
  ];

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="login-logo small" aria-hidden>T</span> Teams Rebuild</div>
        <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); if (search.trim()) setQuery(search.trim()); }}>
          <Input contentBefore={<SearchRegular />} placeholder="Search messages" value={search} aria-label="Search messages"
            onChange={(_, d) => setSearch(d.value)} appearance="filled-darker" />
        </form>
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button appearance="transparent" className="me-btn" aria-label="Your profile and status"><PersonAvatar user={me} size={32} /></Button>
          </MenuTrigger>
          <MenuPopover>
            <div className="me-card"><strong>{me.displayName}</strong><div className="muted">{me.email}</div></div>
            <MenuList checkedValues={{ presence: [me.presence === "InACall" || me.presence === "Offline" ? "Available" : me.presence] }}
              onCheckedValueChange={(_, d) => setPresence({ variables: { presence: d.checkedItems[0] } })}>
              {["Available", "Busy", "DoNotDisturb", "BeRightBack", "Away"].map((p) => (
                <MenuItemRadio key={p} name="presence" value={p}>{PRESENCE_LABEL[p]}</MenuItemRadio>
              ))}
              <MenuDivider />
              <MenuItem icon={<SignOutRegular />} onClick={onSignOut}>Sign out</MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
      </header>

      <nav className="appbar" aria-label="Apps">
        {apps.map((a) => (
          <button key={a.id} className={`app-btn${app === a.id ? " active" : ""}`} onClick={() => goApp(a.id)} aria-current={app === a.id}>
            <span className="app-icon">{app === a.id ? a.active : a.icon}
              {a.badge > 0 && <CounterBadge className="app-badge" count={a.badge} size="small" color="danger" />}</span>
            <span className="app-label">{a.label}</span>
          </button>
        ))}
      </nav>

      <aside className="pane">
        {app === "chat" && <ChatPane me={me.mri} nav={nav} onNav={go} />}
        {app === "teams" && <TeamsPane nav={nav} onNav={go} />}
        {app === "activity" && <ActivityPane onNav={(n) => { go(n); }} />}
        {app === "calls" && <CallsPane me={me.mri} onNav={go} />}
      </aside>

      <main className="stage">
        {call.call || call.error ? <CallStage me={me.mri} meName={me.displayName} names={names} /> : null}
        <div className={`stage-content${call.call ? " with-call" : ""}`}>
          {query ? <SearchView q={query} onNav={go} />
            : nav.threadId ? <Conversation key={nav.threadId} threadId={nav.threadId} me={me.mri} focusMessage={nav.focusMessage} />
            : <div className="empty"><div><h2>Welcome, {me.displayName.split(" ")[0]}</h2>
                <p className="muted">Pick a chat or channel on the left, or start something new.</p></div></div>}
        </div>
      </main>
      <IncomingCall me={me.mri} />
    </div>
  );
}
