// GraphQL API. Real Teams resolves ~4,900 colocated GraphQL operations locally in a
// SharedWorker against REST backends (notes.md §3); we serve one schema from the server.
import { makeExecutableSchema } from "@graphql-tools/schema";
import { GraphQLError } from "graphql";
import jwt from "jsonwebtoken";
import {
  all, one, run, tx, now, newId, newMri, newChatId, newTeamThreadId,
  hashPassword, checkPassword, htmlToText, type Row,
} from "./db.js";
import { publish, subscribe, isOnline, onlineMris, onConnectionChange, type TrouterEvent } from "./trouter.js";

export const JWT_SECRET = process.env.TEAMS_JWT_SECRET ?? "dev-only-secret-change-me";
export type Ctx = { mri: string | null };

const typeDefs = /* GraphQL */ `
  enum Presence { Available Busy DoNotDisturb BeRightBack Away Offline InACall }

  type User { mri: ID! email: String! displayName: String! presence: Presence! }
  type AuthPayload { token: String! user: User! }

  type ReactionGroup { emoji: String! count: Int! users: [User!]! reactedByMe: Boolean! }
  type FileRef { id: ID! name: String! size: Int! mime: String! url: String! }

  type Message {
    id: ID!
    threadId: ID!
    parentId: ID
    from: User
    messageType: String!
    subject: String
    content: String!
    createdAt: Float!
    editedAt: Float
    deleted: Boolean!
    reactions: [ReactionGroup!]!
    mentions: [User!]!
    files: [FileRef!]!
    replyCount: Int!
    replies: [Message!]!
  }

  type Thread {
    id: ID!
    type: String!
    topic: String
    description: String
    isGeneral: Boolean!
    members: [User!]!
    myRole: String
    team: Thread
    channels: [Thread!]!
    lastMessage: Message
    lastActivityAt: Float!
    unreadCount: Int!
    activeCall: Call
  }

  type Call { id: ID! threadId: ID! video: Boolean! startedAt: Float! startedBy: User! participants: [User!]! }

  type Activity {
    id: ID! kind: String! actor: User! thread: Thread! messageId: ID preview: String createdAt: Float! read: Boolean!
  }

  type SearchHit { message: Message! thread: Thread! snippet: String! }

  type TrouterEvent {
    kind: String!
    threadId: ID
    messageId: ID
    message: Message
    mri: ID
    user: User
    call: Call
    payload: String
  }

  type Query {
    me: User
    users(search: String): [User!]!
    chats: [Thread!]!
    teams: [Thread!]!
    thread(id: ID!): Thread
    messages(threadId: ID!, before: Float, limit: Int): [Message!]!
    message(id: ID!): Message
    activity(limit: Int): [Activity!]!
    search(q: String!): [SearchHit!]!
    activeCalls: [Call!]!
  }

  type Mutation {
    signup(email: String!, displayName: String!, password: String!): AuthPayload!
    login(email: String!, password: String!): AuthPayload!
    setPresence(presence: Presence): User!

    createChat(memberMris: [ID!]!, topic: String): Thread!
    addMembers(threadId: ID!, memberMris: [ID!]!): Thread!
    renameThread(threadId: ID!, topic: String!): Thread!

    createTeam(name: String!, description: String): Thread!
    createChannel(teamId: ID!, name: String!, description: String): Thread!

    sendMessage(threadId: ID!, content: String!, parentId: ID, subject: String, mentionMris: [ID!], fileIds: [ID!]): Message!
    editMessage(id: ID!, content: String!): Message!
    deleteMessage(id: ID!): Message!
    toggleReaction(messageId: ID!, emoji: String!): Message!
    markRead(threadId: ID!): Thread!
    markActivityRead: Boolean!
    setTyping(threadId: ID!): Boolean!

    startCall(threadId: ID!, video: Boolean!): Call!
    joinCall(callId: ID!): Call!
    leaveCall(callId: ID!): Boolean!
    declineCall(callId: ID!): Boolean!
    callSignal(callId: ID!, toMri: ID!, signal: String!): Boolean!
  }

  type Subscription { events: TrouterEvent! }
`;

// ---------- helpers ----------
const fail = (msg: string, code = "BAD_REQUEST") => { throw new GraphQLError(msg, { extensions: { code } }); };
const need = (ctx: Ctx) => ctx.mri ?? fail("Not signed in", "UNAUTHENTICATED");
const user = (mri: string | null | undefined) => (mri ? one("SELECT * FROM users WHERE mri = ?", mri) : undefined);
const thread = (id: string) => one("SELECT * FROM threads WHERE id = ?", id);

/** The thread whose member list governs access (a channel inherits from its team). */
const rosterId = (t: Row) => (t.type === "channel" ? t.team_id : t.id);
const audience = (t: Row) => all("SELECT mri FROM members WHERE thread_id = ?", rosterId(t)).map((r) => r.mri as string);
const isMember = (t: Row, mri: string) => !!one("SELECT 1 FROM members WHERE thread_id = ? AND mri = ?", rosterId(t), mri);

function access(ctx: Ctx, threadId: string) {
  const mri = need(ctx);
  const t = thread(threadId) ?? fail("Thread not found", "NOT_FOUND");
  if (!isMember(t, mri)) fail("Not a member of this thread", "FORBIDDEN");
  return { mri, t };
}

const sign = (mri: string) => jwt.sign({ mri }, JWT_SECRET, { expiresIn: "30d" });
export const verifyToken = (token?: string | null): string | null => {
  if (!token) return null;
  try { return (jwt.verify(token.replace(/^Bearer /, ""), JWT_SECRET) as { mri: string }).mri; } catch { return null; }
};

// ---------- calls (in-memory, like the calling service's live state) ----------
interface CallState { id: string; threadId: string; video: boolean; startedAt: number; startedBy: string; participants: Set<string> }
const calls = new Map<string, CallState>();
const callInThread = (threadId: string) => [...calls.values()].find((c) => c.threadId === threadId);
const inCall = (mri: string) => [...calls.values()].some((c) => c.participants.has(mri));

function presenceOf(u: Row): string {
  if (!isOnline(u.mri)) return "Offline";
  if (u.presence_override === "DoNotDisturb") return "DoNotDisturb";
  if (inCall(u.mri)) return "InACall";
  return u.presence_override ?? "Available";
}
function broadcastPresence(mri: string) {
  publish(onlineMris(), { kind: "presence", mri });
}
onConnectionChange((mri) => broadcastPresence(mri));

function systemMessage(t: Row, type: string, content: string, from: string | null) {
  const id = newId();
  run(`INSERT INTO messages (id, thread_id, from_mri, message_type, content, created_at) VALUES (?,?,?,?,?,?)`,
    id, t.id, from, type, content, now());
  touch(t);
  publish(audience(t), { kind: "newMessage", threadId: t.id, messageId: id });
  return id;
}
function touch(t: Row) {
  const ts = now();
  run("UPDATE threads SET last_activity_at = ? WHERE id = ?", ts, t.id);
  if (t.team_id) run("UPDATE threads SET last_activity_at = ? WHERE id = ?", ts, t.team_id);
}
function addActivity(mri: string, kind: string, actor: string, threadId: string, messageId: string | null, preview: string) {
  if (mri === actor) return;
  const id = newId();
  run(`INSERT INTO activity (id, mri, kind, actor_mri, thread_id, message_id, preview, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    id, mri, kind, actor, threadId, messageId, preview.slice(0, 200), now());
  publish([mri], { kind: "activity", threadId, messageId, payload: JSON.stringify({ id, kind }) });
}

const callObj = (c: CallState) => ({ ...c, participants: [...c.participants] });

function endCallIfEmpty(c: CallState) {
  if (c.participants.size > 0) return;
  calls.delete(c.id);
  const t = thread(c.threadId);
  if (t) {
    const mins = Math.max(1, Math.round((now() - c.startedAt) / 60000));
    systemMessage(t, "Event/Call", `Call ended · ${mins} min`, null);
    publish(audience(t), { kind: "callUpdated", threadId: t.id, payload: JSON.stringify({ id: c.id, ended: true }) });
  }
}

// ---------- resolvers ----------
const resolvers = {
  User: {
    displayName: (u: Row) => u.display_name,
    presence: (u: Row) => presenceOf(u),
  },
  Message: {
    threadId: (m: Row) => m.thread_id,
    parentId: (m: Row) => m.parent_id,
    from: (m: Row) => user(m.from_mri),
    messageType: (m: Row) => m.message_type,
    content: (m: Row) => (m.deleted_at ? "" : m.content),
    createdAt: (m: Row) => m.created_at,
    editedAt: (m: Row) => m.edited_at,
    deleted: (m: Row) => !!m.deleted_at,
    reactions: (m: Row, _: unknown, ctx: Ctx) => {
      const rows = all("SELECT r.emoji, r.mri FROM reactions r WHERE r.message_id = ? ORDER BY r.created_at", m.id);
      const groups = new Map<string, string[]>();
      for (const r of rows) groups.set(r.emoji, [...(groups.get(r.emoji) ?? []), r.mri]);
      return [...groups].map(([emoji, mris]) => ({
        emoji, count: mris.length, users: mris.map(user).filter(Boolean), reactedByMe: mris.includes(ctx.mri ?? ""),
      }));
    },
    mentions: (m: Row) => all("SELECT u.* FROM mentions x JOIN users u ON u.mri = x.mri WHERE x.message_id = ?", m.id),
    files: (m: Row) => all("SELECT * FROM files WHERE message_id = ?", m.id),
    replyCount: (m: Row) => (one("SELECT count(*) n FROM messages WHERE parent_id = ? AND deleted_at IS NULL", m.id)?.n ?? 0),
    replies: (m: Row) => all("SELECT * FROM messages WHERE parent_id = ? ORDER BY created_at", m.id),
  },
  FileRef: { url: (f: Row) => `/api/files/${f.id}` },
  Thread: {
    isGeneral: (t: Row) => !!t.is_general,
    members: (t: Row) => all(
      "SELECT u.* FROM members m JOIN users u ON u.mri = m.mri WHERE m.thread_id = ? ORDER BY m.joined_at", rosterId(t)),
    myRole: (t: Row, _: unknown, ctx: Ctx) =>
      one("SELECT role FROM members WHERE thread_id = ? AND mri = ?", rosterId(t), ctx.mri)?.role ?? null,
    team: (t: Row) => (t.team_id ? thread(t.team_id) : null),
    channels: (t: Row) => (t.type === "team"
      ? all("SELECT * FROM threads WHERE team_id = ? ORDER BY is_general DESC, topic COLLATE NOCASE", t.id) : []),
    lastMessage: (t: Row) => one(
      "SELECT * FROM messages WHERE thread_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1", t.id),
    lastActivityAt: (t: Row) => t.last_activity_at,
    unreadCount: (t: Row, _: unknown, ctx: Ctx) => {
      if (t.type === "team") {
        return one(`SELECT count(*) n FROM messages m JOIN threads c ON c.id = m.thread_id
          LEFT JOIN horizons h ON h.thread_id = m.thread_id AND h.mri = ?
          WHERE c.team_id = ? AND m.from_mri IS NOT ? AND m.created_at > coalesce(h.read_at, 0)`, ctx.mri, t.id, ctx.mri)?.n ?? 0;
      }
      return one(`SELECT count(*) n FROM messages m LEFT JOIN horizons h ON h.thread_id = m.thread_id AND h.mri = ?
        WHERE m.thread_id = ? AND m.from_mri IS NOT ? AND m.deleted_at IS NULL AND m.created_at > coalesce(h.read_at, 0)`,
        ctx.mri, t.id, ctx.mri)?.n ?? 0;
    },
    activeCall: (t: Row) => { const c = callInThread(t.id); return c ? callObj(c) : null; },
  },
  Call: {
    startedBy: (c: Row) => user(c.startedBy),
    participants: (c: Row) => (c.participants as string[]).map(user).filter(Boolean),
  },
  Activity: {
    actor: (a: Row) => user(a.actor_mri),
    thread: (a: Row) => thread(a.thread_id),
    messageId: (a: Row) => a.message_id,
    createdAt: (a: Row) => a.created_at,
    read: (a: Row) => !!a.read,
  },
  TrouterEvent: {
    message: (e: TrouterEvent) => (e.messageId ? one("SELECT * FROM messages WHERE id = ?", e.messageId) : null),
    user: (e: TrouterEvent) => user(e.mri),
    call: (e: TrouterEvent) => {
      const id = e.payload ? JSON.parse(e.payload).id : null;
      const c = id && calls.get(id);
      return c ? callObj(c) : null;
    },
  },

  Query: {
    me: (_: unknown, __: unknown, ctx: Ctx) => user(ctx.mri),
    users: (_: unknown, { search }: { search?: string }, ctx: Ctx) => {
      need(ctx);
      const q = `%${(search ?? "").trim()}%`;
      return all(`SELECT * FROM users WHERE (display_name LIKE ? OR email LIKE ?) ORDER BY display_name COLLATE NOCASE LIMIT 50`, q, q);
    },
    chats: (_: unknown, __: unknown, ctx: Ctx) => all(
      `SELECT t.* FROM threads t JOIN members m ON m.thread_id = t.id WHERE t.type = 'chat' AND m.mri = ?
       ORDER BY t.last_activity_at DESC`, need(ctx)),
    teams: (_: unknown, __: unknown, ctx: Ctx) => all(
      `SELECT t.* FROM threads t JOIN members m ON m.thread_id = t.id WHERE t.type = 'team' AND m.mri = ?
       ORDER BY t.topic COLLATE NOCASE`, need(ctx)),
    thread: (_: unknown, { id }: { id: string }, ctx: Ctx) => access(ctx, id).t,
    messages: (_: unknown, a: { threadId: string; before?: number; limit?: number }, ctx: Ctx) => {
      const { t } = access(ctx, a.threadId);
      const limit = Math.min(a.limit ?? 50, 200);
      // channels show root posts (replies nest under them); chats are flat
      const rootOnly = t.type === "channel" ? "AND parent_id IS NULL" : "";
      const rows = all(`SELECT * FROM messages WHERE thread_id = ? ${rootOnly} AND created_at < ?
        ORDER BY created_at DESC LIMIT ?`, t.id, a.before ?? Number.MAX_SAFE_INTEGER, limit);
      return rows.reverse();
    },
    message: (_: unknown, { id }: { id: string }, ctx: Ctx) => {
      const m = one("SELECT * FROM messages WHERE id = ?", id) ?? fail("Message not found", "NOT_FOUND");
      access(ctx, m.thread_id);
      return m;
    },
    activity: (_: unknown, { limit }: { limit?: number }, ctx: Ctx) =>
      all("SELECT * FROM activity WHERE mri = ? ORDER BY created_at DESC LIMIT ?", need(ctx), Math.min(limit ?? 50, 200)),
    search: (_: unknown, { q }: { q: string }, ctx: Ctx) => {
      const mri = need(ctx);
      const terms = q.split(/\s+/).map((w) => w.replace(/["*]/g, "")).filter(Boolean);
      if (!terms.length) return [];
      const match = terms.map((w) => `"${w}"*`).join(" ");
      const rows = all(`SELECT m.*, snippet(messages_fts, 0, '[[', ']]', '…', 12) AS snip
        FROM messages_fts f JOIN messages m ON m.id = f.message_id JOIN threads t ON t.id = m.thread_id
        JOIN members mm ON mm.thread_id = (CASE WHEN t.type = 'channel' THEN t.team_id ELSE t.id END) AND mm.mri = ?
        WHERE messages_fts MATCH ? AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 50`, mri, match);
      return rows.map((m) => ({ message: m, thread: thread(m.thread_id), snippet: m.snip }));
    },
    activeCalls: (_: unknown, __: unknown, ctx: Ctx) => {
      const mri = need(ctx);
      return [...calls.values()].filter((c) => { const t = thread(c.threadId); return t && isMember(t, mri); }).map(callObj);
    },
  },

  Mutation: {
    signup: (_: unknown, a: { email: string; displayName: string; password: string }) => {
      const email = a.email.trim().toLowerCase();
      if (!/^\S+@\S+$/.test(email)) fail("Enter a valid email");
      if (a.password.length < 6) fail("Password must be at least 6 characters");
      if (!a.displayName.trim()) fail("Enter your name");
      if (one("SELECT 1 FROM users WHERE email = ?", email)) fail("That email is already registered");
      const mri = newMri();
      run("INSERT INTO users (mri, email, display_name, password_hash, created_at) VALUES (?,?,?,?,?)",
        mri, email, a.displayName.trim(), hashPassword(a.password), now());
      return { token: sign(mri), user: user(mri) };
    },
    login: (_: unknown, a: { email: string; password: string }) => {
      const u = one("SELECT * FROM users WHERE email = ?", a.email.trim().toLowerCase());
      if (!u || !checkPassword(a.password, u.password_hash)) fail("Wrong email or password", "UNAUTHENTICATED");
      return { token: sign(u!.mri), user: u };
    },
    setPresence: (_: unknown, { presence }: { presence?: string | null }, ctx: Ctx) => {
      const mri = need(ctx);
      run("UPDATE users SET presence_override = ? WHERE mri = ?",
        presence && presence !== "Available" && presence !== "InACall" ? presence : null, mri);
      broadcastPresence(mri);
      return user(mri);
    },

    createChat: (_: unknown, a: { memberMris: string[]; topic?: string }, ctx: Ctx) => {
      const mri = need(ctx);
      const others = [...new Set(a.memberMris)].filter((m) => m !== mri);
      if (!others.length) fail("Pick at least one person");
      for (const m of others) if (!user(m)) fail("Unknown user");
      // 1:1 chats are unique per pair (real Teams: 19:<a>_<b>@unq.gbl.spaces)
      if (others.length === 1 && !a.topic) {
        const existing = one(`SELECT t.* FROM threads t WHERE t.type = 'chat' AND t.topic IS NULL
          AND (SELECT count(*) FROM members WHERE thread_id = t.id) = 2
          AND EXISTS (SELECT 1 FROM members WHERE thread_id = t.id AND mri = ?)
          AND EXISTS (SELECT 1 FROM members WHERE thread_id = t.id AND mri = ?)`, mri, others[0]);
        if (existing) return existing;
      }
      const id = newChatId();
      tx(() => {
        run(`INSERT INTO threads (id, type, topic, created_by, created_at, last_activity_at) VALUES (?, 'chat', ?, ?, ?, ?)`,
          id, a.topic?.trim() || null, mri, now(), now());
        for (const m of [mri, ...others])
          run("INSERT INTO members (thread_id, mri, role, joined_at) VALUES (?,?,?,?)", id, m, m === mri ? "Admin" : "User", now());
      });
      publish([mri, ...others], { kind: "threadUpdated", threadId: id });
      return thread(id);
    },
    addMembers: (_: unknown, a: { threadId: string; memberMris: string[] }, ctx: Ctx) => {
      const { mri, t } = access(ctx, a.threadId);
      if (t.type === "channel") fail("Add people to the team instead");
      if (t.type === "team" && one("SELECT role FROM members WHERE thread_id = ? AND mri = ?", t.id, mri)?.role !== "Admin")
        fail("Only team owners can add members", "FORBIDDEN");
      const added: string[] = [];
      for (const m of new Set(a.memberMris)) {
        if (!user(m) || isMember(t, m)) continue;
        run("INSERT INTO members (thread_id, mri, role, joined_at) VALUES (?,?, 'User', ?)", t.id, m, now());
        added.push(m);
      }
      if (added.length) {
        const names = added.map((m) => user(m)!.display_name).join(", ");
        const target = t.type === "team" ? one("SELECT * FROM threads WHERE team_id = ? AND is_general = 1", t.id)! : t;
        systemMessage(target, "ThreadActivity/AddMember", `${user(mri)!.display_name} added ${names}`, null);
        publish(audience(t), { kind: "threadUpdated", threadId: t.id });
      }
      return thread(t.id);
    },
    renameThread: (_: unknown, a: { threadId: string; topic: string }, ctx: Ctx) => {
      const { mri, t } = access(ctx, a.threadId);
      if (t.type !== "chat") fail("Only chats can be renamed here");
      run("UPDATE threads SET topic = ? WHERE id = ?", a.topic.trim() || null, t.id);
      systemMessage(t, "ThreadActivity/TopicUpdate", `${user(mri)!.display_name} renamed the chat to "${a.topic.trim()}"`, null);
      publish(audience(t), { kind: "threadUpdated", threadId: t.id });
      return thread(t.id);
    },

    createTeam: (_: unknown, a: { name: string; description?: string }, ctx: Ctx) => {
      const mri = need(ctx);
      if (!a.name.trim()) fail("Enter a team name");
      const id = newTeamThreadId();
      tx(() => {
        run(`INSERT INTO threads (id, type, topic, description, created_by, created_at, last_activity_at)
             VALUES (?, 'team', ?, ?, ?, ?, ?)`, id, a.name.trim(), a.description ?? null, mri, now(), now());
        run("INSERT INTO members (thread_id, mri, role, joined_at) VALUES (?,?, 'Admin', ?)", id, mri, now());
        run(`INSERT INTO threads (id, type, topic, team_id, is_general, created_by, created_at, last_activity_at)
             VALUES (?, 'channel', 'General', ?, 1, ?, ?, ?)`, newTeamThreadId(), id, mri, now(), now());
      });
      publish([mri], { kind: "threadUpdated", threadId: id });
      return thread(id);
    },
    createChannel: (_: unknown, a: { teamId: string; name: string; description?: string }, ctx: Ctx) => {
      const { mri, t } = access(ctx, a.teamId);
      if (t.type !== "team") fail("Not a team");
      if (!a.name.trim()) fail("Enter a channel name");
      if (one("SELECT 1 FROM threads WHERE team_id = ? AND topic = ? COLLATE NOCASE", t.id, a.name.trim()))
        fail("A channel with that name already exists");
      const id = newTeamThreadId();
      run(`INSERT INTO threads (id, type, topic, description, team_id, created_by, created_at, last_activity_at)
           VALUES (?, 'channel', ?, ?, ?, ?, ?, ?)`, id, a.name.trim(), a.description ?? null, t.id, mri, now(), now());
      publish(audience(t), { kind: "threadUpdated", threadId: t.id });
      return thread(id);
    },

    sendMessage: (_: unknown, a: {
      threadId: string; content: string; parentId?: string; subject?: string; mentionMris?: string[]; fileIds?: string[];
    }, ctx: Ctx) => {
      const { mri, t } = access(ctx, a.threadId);
      if (t.type === "team") fail("Post in a channel");
      const text = htmlToText(a.content);
      if (!text && !a.fileIds?.length) fail("Message is empty");
      let parent: Row | undefined;
      if (a.parentId) {
        parent = one("SELECT * FROM messages WHERE id = ? AND thread_id = ? AND parent_id IS NULL", a.parentId, t.id);
        if (!parent || t.type !== "channel") fail("Replies are only for channel posts");
      }
      const id = newId();
      const roster = new Set(audience(t));
      const mentions = [...new Set(a.mentionMris ?? [])].filter((m) => roster.has(m));
      tx(() => {
        run(`INSERT INTO messages (id, thread_id, parent_id, from_mri, message_type, subject, content, created_at)
             VALUES (?,?,?,?, 'Text', ?, ?, ?)`, id, t.id, a.parentId ?? null, mri,
          parent ? null : a.subject?.trim() || null, a.content, now());
        run("INSERT INTO messages_fts (text, message_id, thread_id) VALUES (?,?,?)",
          [a.subject, text].filter(Boolean).join(" "), id, t.id);
        for (const m of mentions) run("INSERT INTO mentions (message_id, mri) VALUES (?,?)", id, m);
        for (const f of a.fileIds ?? [])
          run("UPDATE files SET message_id = ? WHERE id = ? AND owner_mri = ? AND message_id IS NULL", id, f, mri);
        run(`INSERT INTO horizons (thread_id, mri, read_at) VALUES (?,?,?)
             ON CONFLICT (thread_id, mri) DO UPDATE SET read_at = excluded.read_at`, t.id, mri, now());
        touch(t);
      });
      const preview = text || "Sent a file";
      for (const m of mentions) addActivity(m, "mention", mri, t.id, a.parentId ?? id, preview);
      if (parent) {
        const repliers = all("SELECT DISTINCT from_mri FROM messages WHERE parent_id = ? AND from_mri IS NOT NULL", parent.id)
          .map((r) => r.from_mri as string);
        for (const m of new Set([parent.from_mri, ...repliers]))
          if (m && !mentions.includes(m)) addActivity(m, "reply", mri, t.id, parent.id, preview);
      }
      publish(roster, { kind: "newMessage", threadId: t.id, messageId: id });
      return one("SELECT * FROM messages WHERE id = ?", id);
    },
    editMessage: (_: unknown, a: { id: string; content: string }, ctx: Ctx) => {
      const mri = need(ctx);
      const m = one("SELECT * FROM messages WHERE id = ?", a.id) ?? fail("Message not found", "NOT_FOUND");
      if (m.from_mri !== mri || m.deleted_at) fail("You can only edit your own messages", "FORBIDDEN");
      const text = htmlToText(a.content);
      if (!text) fail("Message is empty");
      run("UPDATE messages SET content = ?, edited_at = ? WHERE id = ?", a.content, now(), m.id);
      run("UPDATE messages_fts SET text = ? WHERE message_id = ?", [m.subject, text].filter(Boolean).join(" "), m.id);
      publish(audience(thread(m.thread_id)!), { kind: "messageUpdated", threadId: m.thread_id, messageId: m.id });
      return one("SELECT * FROM messages WHERE id = ?", m.id);
    },
    deleteMessage: (_: unknown, { id }: { id: string }, ctx: Ctx) => {
      const mri = need(ctx);
      const m = one("SELECT * FROM messages WHERE id = ?", id) ?? fail("Message not found", "NOT_FOUND");
      if (m.from_mri !== mri) fail("You can only delete your own messages", "FORBIDDEN");
      run("UPDATE messages SET deleted_at = ? WHERE id = ?", now(), id);
      run("DELETE FROM messages_fts WHERE message_id = ?", id);
      publish(audience(thread(m.thread_id)!), { kind: "messageUpdated", threadId: m.thread_id, messageId: id });
      return one("SELECT * FROM messages WHERE id = ?", id);
    },
    toggleReaction: (_: unknown, a: { messageId: string; emoji: string }, ctx: Ctx) => {
      const m = one("SELECT * FROM messages WHERE id = ?", a.messageId) ?? fail("Message not found", "NOT_FOUND");
      const { mri, t } = access(ctx, m.thread_id);
      if (one("SELECT 1 FROM reactions WHERE message_id = ? AND mri = ? AND emoji = ?", m.id, mri, a.emoji)) {
        run("DELETE FROM reactions WHERE message_id = ? AND mri = ? AND emoji = ?", m.id, mri, a.emoji);
      } else {
        run("INSERT INTO reactions (message_id, mri, emoji, created_at) VALUES (?,?,?,?)", m.id, mri, a.emoji, now());
        if (m.from_mri) addActivity(m.from_mri, "reaction", mri, t.id, m.parent_id ?? m.id, `${a.emoji} ${htmlToText(m.content)}`);
      }
      publish(audience(t), { kind: "messageUpdated", threadId: t.id, messageId: m.id });
      return m;
    },
    markRead: (_: unknown, { threadId }: { threadId: string }, ctx: Ctx) => {
      const { mri, t } = access(ctx, threadId);
      const ids = t.type === "team" ? all("SELECT id FROM threads WHERE team_id = ?", t.id).map((r) => r.id) : [t.id];
      for (const id of ids)
        run(`INSERT INTO horizons (thread_id, mri, read_at) VALUES (?,?,?)
             ON CONFLICT (thread_id, mri) DO UPDATE SET read_at = excluded.read_at`, id, mri, now());
      publish([mri], { kind: "threadUpdated", threadId: t.team_id ?? t.id });
      return t;
    },
    markActivityRead: (_: unknown, __: unknown, ctx: Ctx) => {
      run("UPDATE activity SET read = 1 WHERE mri = ?", need(ctx));
      return true;
    },
    setTyping: (_: unknown, { threadId }: { threadId: string }, ctx: Ctx) => {
      const { mri, t } = access(ctx, threadId);
      publish(audience(t).filter((m) => m !== mri), { kind: "typing", threadId: t.id, mri });
      return true;
    },

    // Calls: the server only tracks roster + relays WebRTC signalling (offer/answer/ICE)
    // over the push channel. Media flows peer-to-peer (real Teams: native SlimCore + media relays).
    startCall: (_: unknown, a: { threadId: string; video: boolean }, ctx: Ctx) => {
      const { mri, t } = access(ctx, a.threadId);
      if (t.type === "team") fail("Start a meeting in a channel");
      if (inCall(mri)) fail("You're already in a call");
      let c = callInThread(t.id);
      if (!c) {
        c = { id: newId(), threadId: t.id, video: a.video, startedAt: now(), startedBy: mri, participants: new Set() };
        calls.set(c.id, c);
        systemMessage(t, "Event/Call", t.type === "channel" ? "Meeting started" : "Call started", mri);
      }
      c.participants.add(mri);
      publish(audience(t), { kind: "callUpdated", threadId: t.id, mri, payload: JSON.stringify({ id: c.id, ring: true }) });
      broadcastPresence(mri);
      return callObj(c);
    },
    joinCall: (_: unknown, { callId }: { callId: string }, ctx: Ctx) => {
      const c = calls.get(callId) ?? fail("This call has ended", "NOT_FOUND");
      const { mri, t } = access(ctx, c!.threadId);
      if (inCall(mri) && !c!.participants.has(mri)) fail("You're already in another call");
      c!.participants.add(mri);
      publish(audience(t), { kind: "callUpdated", threadId: t.id, mri, payload: JSON.stringify({ id: c!.id }) });
      broadcastPresence(mri);
      return callObj(c!);
    },
    leaveCall: (_: unknown, { callId }: { callId: string }, ctx: Ctx) => {
      const mri = need(ctx);
      const c = calls.get(callId);
      if (!c || !c.participants.delete(mri)) return false;
      const t = thread(c.threadId)!;
      publish(c.participants, { kind: "callSignal", mri, payload: JSON.stringify({ callId, from: mri, signal: { type: "bye" } }) });
      publish(audience(t), { kind: "callUpdated", threadId: t.id, mri, payload: JSON.stringify({ id: c.id }) });
      broadcastPresence(mri);
      endCallIfEmpty(c);
      return true;
    },
    declineCall: (_: unknown, { callId }: { callId: string }, ctx: Ctx) => {
      const mri = need(ctx);
      const c = calls.get(callId);
      if (!c) return false;
      publish(c.participants, { kind: "callDeclined", mri, threadId: c.threadId, payload: JSON.stringify({ id: c.id }) });
      return true;
    },
    callSignal: (_: unknown, a: { callId: string; toMri: string; signal: string }, ctx: Ctx) => {
      const mri = need(ctx);
      const c = calls.get(a.callId);
      if (!c || !c.participants.has(mri) || !c.participants.has(a.toMri)) return false;
      publish([a.toMri], { kind: "callSignal", mri, payload: JSON.stringify({ callId: c.id, from: mri, signal: JSON.parse(a.signal) }) });
      return true;
    },
  },

  Subscription: {
    events: {
      subscribe: (_: unknown, __: unknown, ctx: Ctx) => {
        const mri = need(ctx);
        return (async function* () {
          try {
            for await (const e of subscribe(mri)) yield { events: e };
          } finally {
            // dropping the last endpoint takes you out of any call you were in
            for (const c of calls.values()) {
              if (c.participants.has(mri) && !isOnline(mri)) {
                c.participants.delete(mri);
                publish(c.participants, { kind: "callSignal", mri, payload: JSON.stringify({ callId: c.id, from: mri, signal: { type: "bye" } }) });
                const t = thread(c.threadId);
                if (t) publish(audience(t), { kind: "callUpdated", threadId: t.id, mri, payload: JSON.stringify({ id: c.id }) });
                endCallIfEmpty(c);
              }
            }
          }
        })();
      },
    },
  },
};

export const schema = makeExecutableSchema({ typeDefs, resolvers });

/** Called by the upload route. */
export function recordUpload(owner: string, id: string, name: string, size: number, mime: string) {
  run("INSERT INTO files (id, owner_mri, name, size, mime, created_at) VALUES (?,?,?,?,?,?)", id, owner, name, size, mime, now());
  return one("SELECT * FROM files WHERE id = ?", id);
}
/** A file is readable by its owner or by anyone who can see the message it's attached to. */
export function canReadFile(mri: string, fileId: string) {
  const f = one("SELECT * FROM files WHERE id = ?", fileId);
  if (!f) return null;
  if (f.owner_mri === mri) return f;
  const m = f.message_id && one("SELECT thread_id FROM messages WHERE id = ?", f.message_id);
  const t = m && thread(m.thread_id);
  return t && isMember(t, mri) ? f : null;
}
