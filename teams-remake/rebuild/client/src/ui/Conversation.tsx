import { useMutation, useQuery } from "@apollo/client";
import { AvatarGroup, AvatarGroupItem, Button, Spinner, Tooltip, partitionAvatarGroupItems } from "@fluentui/react-components";
import { ArrowReplyRegular, CallRegular, EditRegular, PersonAddRegular, VideoRegular } from "@fluentui/react-icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { joinCall, startCall, useCall } from "../calls";
import { ADD_MEMBERS, MARK_READ, MESSAGES, RENAME, THREAD_Q, type Message, type Thread } from "../gql";
import { useTyping } from "../push";
import { PersonAvatar, threadTitle } from "./common";
import { Composer } from "./Composer";
import { NameDialog, PeoplePicker } from "./dialogs";
import { MessageItem } from "./MessageItem";

export function Conversation({ threadId, me, focusMessage }: { threadId: string; me: string; focusMessage?: string | null }) {
  const { data: tData, error: tError } = useQuery(THREAD_Q, { variables: { id: threadId } });
  const { data, loading, fetchMore } = useQuery(MESSAGES, { variables: { threadId } });
  const [markRead] = useMutation(MARK_READ);
  const [addMembers] = useMutation(ADD_MEMBERS, { refetchQueries: ["Chats", "Teams", "Thread"] });
  const [rename] = useMutation(RENAME);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [olderDone, setOlderDone] = useState(false);
  const call = useCall();
  const typingMris = useTyping(threadId);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const t: Thread | undefined = tData?.thread;
  const messages: Message[] = data?.messages ?? [];
  const lastId = messages.at(-1)?.id;
  const lastReplyCount = messages.reduce((n, m) => n + m.replyCount, 0);

  // keep pinned to the bottom when new messages arrive (unless the user scrolled up)
  useLayoutEffect(() => {
    if (stick.current && list.current && !focusMessage) list.current.scrollTop = list.current.scrollHeight;
  }, [lastId, lastReplyCount, typingMris.length, focusMessage]);
  useEffect(() => { stick.current = true; setOlderDone(false); }, [threadId]);
  useEffect(() => {
    if (!focusMessage || !messages.length) return;
    document.getElementById(`msg-${focusMessage}`)?.scrollIntoView({ block: "center" });
  }, [focusMessage, messages.length]);
  useEffect(() => {
    if (lastId && document.visibilityState === "visible") markRead({ variables: { threadId } }).catch(() => {});
  }, [lastId, lastReplyCount, threadId, markRead]);

  if (tError) return <div className="empty">{tError.message}</div>;
  if (!t) return <div className="empty"><Spinner /></div>;

  const isChannel = t.type === "channel";
  const title = isChannel ? t.topic : threadTitle(t, me);
  const others = t.members.filter((m) => m.mri !== me);
  const inThisCall = call.call?.threadId === t.id;
  const typingNames = typingMris.map((mri) => t.members.find((m) => m.mri === mri)?.displayName).filter(Boolean);
  const { inlineItems, overflowItems } = partitionAvatarGroupItems({ items: t.members, maxInlineItems: 4 });

  const loadOlder = async () => {
    stick.current = false;
    const res = await fetchMore({ variables: { threadId, before: messages[0].createdAt } });
    if ((res.data?.messages?.length ?? 0) < 50) setOlderDone(true);
  };

  return (
    <section className="conversation" aria-label={title ?? "Conversation"}>
      <header className="conv-header">
        {isChannel ? <div className="channel-glyph">#</div> : others.length === 1 ? <PersonAvatar user={others[0]} size={32} /> : null}
        <div className="conv-title">
          <h2>{title}</h2>
          {isChannel && (tData.thread.team?.topic) && <span className="muted">{tData.thread.team.topic}</span>}
        </div>
        {!isChannel && (t.topic !== null || others.length > 1) ? (
          <Tooltip content="Rename chat" relationship="label"><Button appearance="subtle" icon={<EditRegular />} onClick={() => setRenaming(true)} /></Tooltip>
        ) : null}
        <div className="spacer" />
        <AvatarGroup layout="stack" size={24} className="conv-members">
          {inlineItems.map((m) => <AvatarGroupItem key={m.mri} name={m.displayName} />)}
          {overflowItems && <AvatarGroupItem name={`+${overflowItems.length}`} />}
        </AvatarGroup>
        {(!isChannel || t.myRole === "Admin") && (
          <Tooltip content={isChannel ? "Add people to team" : "Add people"} relationship="label">
            <Button appearance="subtle" icon={<PersonAddRegular />} onClick={() => setAdding(true)} />
          </Tooltip>
        )}
        {t.activeCall && !inThisCall ? (
          <Button appearance="primary" className="join-btn" icon={<VideoRegular />} disabled={!!call.call}
            onClick={() => joinCall(t.activeCall!.id, true)}>Join</Button>
        ) : (
          <>
            <Tooltip content={isChannel ? "Meet now" : "Video call"} relationship="label">
              <Button appearance="subtle" icon={<VideoRegular />} disabled={!!call.call} onClick={() => startCall(t.id, true)} />
            </Tooltip>
            {!isChannel && (
              <Tooltip content="Audio call" relationship="label">
                <Button appearance="subtle" icon={<CallRegular />} disabled={!!call.call} onClick={() => startCall(t.id, false)} />
              </Tooltip>
            )}
          </>
        )}
      </header>

      <div className="messages" ref={list} onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}>
        {messages.length >= 50 && !olderDone && (
          <div className="load-older"><Button size="small" onClick={loadOlder}>Load older messages</Button></div>
        )}
        {loading && !messages.length && <Spinner />}
        {!loading && !messages.length && (
          <div className="empty-thread">
            {isChannel ? "Start a conversation in this channel." : `This is the start of your chat with ${title}.`}
          </div>
        )}
        {isChannel
          ? messages.map((m) => <ChannelPost key={m.id} post={m} me={me} members={t.members} focus={focusMessage} />)
          : messages.map((m, i) => {
              const prev = messages[i - 1];
              const compact = !!prev && prev.messageType === "Text" && m.messageType === "Text" &&
                prev.from?.mri === m.from?.mri && m.createdAt - prev.createdAt < 5 * 60_000;
              return <MessageItem key={m.id} m={m} me={me} compact={compact} highlight={m.id === focusMessage} />;
            })}
      </div>

      <div className="typing" aria-live="polite">
        {typingNames.length > 0 && `${typingNames.join(", ")} ${typingNames.length > 1 ? "are" : "is"} typing…`}
      </div>
      <Composer key={threadId} threadId={t.id} members={t.members} me={me} withSubject={isChannel} autoFocus
        placeholder={isChannel ? "Start a new conversation. Type @ to mention someone." : "Type a message"}
        onSent={() => { stick.current = true; }} />

      <PeoplePicker open={adding} title={isChannel ? `Add people to ${tData.thread.team?.topic}` : "Add people to this chat"} action="Add"
        exclude={t.members.map((m) => m.mri)} onClose={() => setAdding(false)}
        onPick={async (mris) => { await addMembers({ variables: { threadId: isChannel ? tData.thread.team.id : t.id, memberMris: mris } }); }} />
      <NameDialog open={renaming} title="Rename chat" label="Chat name" action="Save" onClose={() => setRenaming(false)}
        onSubmit={async (name) => { await rename({ variables: { threadId: t.id, topic: name } }); }} />
    </section>
  );
}

function ChannelPost({ post, me, members, focus }: { post: Message; me: string; members: Thread["members"]; focus?: string | null }) {
  const [replying, setReplying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const replies = post.replies ?? [];
  if (post.messageType !== "Text") return <MessageItem m={post} me={me} />;
  const shown = expanded ? replies : replies.slice(-2);
  return (
    <article className={`post${focus === post.id ? " msg-highlight" : ""}`}>
      <MessageItem m={post} me={me} />
      {replies.length > shown.length && (
        <button className="see-more" onClick={() => setExpanded(true)}>See {replies.length - shown.length} more {replies.length - shown.length === 1 ? "reply" : "replies"}</button>
      )}
      <div className="replies">
        {shown.map((r) => <MessageItem key={r.id} m={r} me={me} highlight={r.id === focus} />)}
      </div>
      {replying ? (
        <div className="reply-composer">
          <Composer threadId={post.threadId} parentId={post.id} members={members} me={me} placeholder="Reply" autoFocus
            onSent={() => setReplying(false)} />
        </div>
      ) : (
        <button className="reply-btn" onClick={() => setReplying(true)}><ArrowReplyRegular /> Reply</button>
      )}
    </article>
  );
}
