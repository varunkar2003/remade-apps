import { useQuery } from "@apollo/client";
import { Spinner } from "@fluentui/react-components";
import { Fragment } from "react";
import { SEARCH } from "../gql";
import { PersonAvatar, timeLabel } from "./common";
import type { Nav } from "./panes";

/** FTS5 snippet uses [[ ]] around hits; render those as <mark> without injecting HTML. */
function Snippet({ text }: { text: string }) {
  const clean = text.replace(/<at id="[^"]*">([^<]*)<\/at>/g, "@$1");
  return <>{clean.split(/\[\[|\]\]/).map((s, i) => (i % 2 ? <mark key={i}>{s}</mark> : <Fragment key={i}>{s}</Fragment>))}</>;
}

export function SearchView({ q, onNav }: { q: string; onNav: (n: Nav) => void }) {
  const { data, loading, error } = useQuery(SEARCH, { variables: { q }, skip: !q.trim(), fetchPolicy: "network-only" });
  const hits = data?.search ?? [];
  return (
    <section className="search-view" aria-label="Search results">
      <h2>Results for “{q}”</h2>
      {loading && <Spinner />}
      {error && <div role="alert">{error.message}</div>}
      {!loading && !hits.length && <div className="muted">No messages found.</div>}
      {hits.map((h: any) => (
        <button key={h.message.id} className="search-hit" onClick={() => onNav({ threadId: h.thread.id, focusMessage: h.message.parentId ?? h.message.id })}>
          <PersonAvatar user={{ displayName: h.message.from?.displayName ?? "?" }} size={28} presence={false} />
          <span className="list-text">
            <span className="list-title">{h.message.from?.displayName} <span className="muted">· {timeLabel(h.message.createdAt)}</span></span>
            <span className="list-sub"><Snippet text={h.snippet} /></span>
            <span className="list-sub muted">{h.thread.type === "channel" ? `${h.thread.team?.topic} › ${h.thread.topic}` : h.thread.topic ?? "Chat"}</span>
          </span>
        </button>
      ))}
    </section>
  );
}
