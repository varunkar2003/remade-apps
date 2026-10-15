// End-to-end smoke test: boots the real server on a temp DB, signs up two users,
// opens alice's push channel, has bob message her, and checks every core flow.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { createClient } from "graphql-ws";

const dir = mkdtempSync(path.join(tmpdir(), "teams-smoke-"));
const PORT = 4999;
const URL = `http://localhost:${PORT}/graphql`;
const srv = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  env: { ...process.env, PORT: String(PORT), TEAMS_DATA_DIR: dir }, stdio: ["ignore", "pipe", "inherit"],
});
await new Promise<void>((r) => srv.stdout!.on("data", (d) => String(d).includes("server on") && r()));

let failures = 0;
const check = (name: string, ok: unknown) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failures++; };

async function gql(query: string, variables: object = {}, token?: string) {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json() as any;
  if (body.errors) throw new Error(body.errors[0].message);
  return body.data;
}
const signup = (email: string, displayName: string) =>
  gql(`mutation($e:String!,$n:String!){signup(email:$e,displayName:$n,password:"secret1"){token user{mri}}}`,
    { e: email, n: displayName }).then((d) => d.signup);

try {
  const alice = await signup("alice@test.dev", "Alice");
  const bob = await signup("bob@test.dev", "Bob");
  check("signup returns token + MRI", alice.token && alice.user.mri.startsWith("8:orgid:"));

  // alice's push channel
  const events: any[] = [];
  const ws = createClient({ url: `ws://localhost:${PORT}/graphql`, webSocketImpl: WebSocket, connectionParams: { token: alice.token } });
  ws.subscribe({ query: "subscription{events{kind threadId mri message{content from{displayName}}}}" },
    { next: (v: any) => events.push(v.data.events), error: (e) => console.error(e), complete: () => {} });
  await new Promise((r) => setTimeout(r, 300));
  check("push channel connects", events.some((e) => e.kind === "connected"));

  const presence = await gql(`query($q:String){users(search:$q){presence}}`, { q: "alice" }, bob.token);
  check("alice shows Available while connected", presence.users[0].presence === "Available");

  const chat = (await gql(`mutation($m:[ID!]!){createChat(memberMris:$m){id}}`, { m: [alice.user.mri] }, bob.token)).createChat;
  const again = (await gql(`mutation($m:[ID!]!){createChat(memberMris:$m){id}}`, { m: [alice.user.mri] }, bob.token)).createChat;
  check("1:1 chat id is reused", chat.id === again.id);

  await gql(`mutation($t:ID!){setTyping(threadId:$t)}`, { t: chat.id }, bob.token);
  await gql(`mutation($t:ID!,$c:String!,$m:[ID!]){sendMessage(threadId:$t,content:$c,mentionMris:$m){id}}`,
    { t: chat.id, c: "<p>hello <b>alice</b> about the quarterly roadmap</p>", m: [alice.user.mri] }, bob.token);
  await new Promise((r) => setTimeout(r, 300));
  check("typing pushed to alice", events.some((e) => e.kind === "typing" && e.threadId === chat.id));
  const pushed = events.find((e) => e.kind === "newMessage");
  check("new message pushed to alice with content", pushed?.message?.content.includes("hello") && pushed.message.from.displayName === "Bob");

  const chats = await gql(`{chats{id unreadCount lastMessage{content}}}`, {}, alice.token);
  check("alice sees 1 unread", chats.chats[0].unreadCount === 1);
  await gql(`mutation($t:ID!){markRead(threadId:$t){id}}`, { t: chat.id }, alice.token);
  check("markRead clears unread", (await gql(`{chats{unreadCount}}`, {}, alice.token)).chats[0].unreadCount === 0);

  const act = await gql(`{activity{kind actor{displayName}}}`, {}, alice.token);
  check("mention lands in alice's activity", act.activity[0]?.kind === "mention");

  const hits = await gql(`query{search(q:"roadm"){snippet thread{id}}}`, {}, alice.token);
  check("full-text prefix search finds message", hits.search.length === 1 && hits.search[0].snippet.includes("[["));
  const carol = await signup("carol@test.dev", "Carol");
  check("search is scoped to my threads", (await gql(`query{search(q:"roadmap"){snippet}}`, {}, carol.token)).search.length === 0);

  // teams + channels + replies
  const team = (await gql(`mutation{createTeam(name:"Design"){id channels{id topic isGeneral}}}`, {}, alice.token)).createTeam;
  check("team gets General channel", team.channels.length === 1 && team.channels[0].isGeneral);
  await gql(`mutation($t:ID!,$m:[ID!]!){addMembers(threadId:$t,memberMris:$m){id}}`, { t: team.id, m: [bob.user.mri] }, alice.token);
  const general = team.channels[0].id;
  const post = (await gql(`mutation($t:ID!){sendMessage(threadId:$t,content:"Kickoff",subject:"Plan"){id}}`, { t: general }, alice.token)).sendMessage;
  await gql(`mutation($t:ID!,$p:ID!){sendMessage(threadId:$t,content:"On it",parentId:$p){id}}`, { t: general, p: post.id }, bob.token);
  const posts = await gql(`query($t:ID!){messages(threadId:$t){subject content replyCount replies{content}}}`, { t: general }, bob.token);
  const root = posts.messages.find((m: any) => m.subject === "Plan");
  check("channel post has threaded reply", root?.replyCount === 1 && root.replies[0].content === "On it");
  check("reply notifies post author", (await gql(`{activity{kind}}`, {}, alice.token)).activity.some((a: any) => a.kind === "reply"));
  let denied = false;
  try { await gql(`query($t:ID!){messages(threadId:$t){id}}`, { t: general }, carol.token); } catch { denied = true; }
  check("non-member cannot read channel", denied);

  const r = await gql(`mutation($m:ID!){toggleReaction(messageId:$m,emoji:"👍"){reactions{emoji count reactedByMe}}}`, { m: post.id }, bob.token);
  check("reaction recorded", r.toggleReaction.reactions[0]?.count === 1 && r.toggleReaction.reactions[0].reactedByMe);

  // calls: roster + signalling relay
  const call = (await gql(`mutation($t:ID!){startCall(threadId:$t,video:true){id}}`, { t: chat.id }, bob.token)).startCall;
  await gql(`mutation($c:ID!){joinCall(callId:$c){id}}`, { c: call.id }, alice.token);
  const ok = (await gql(`mutation($c:ID!,$to:ID!,$s:String!){callSignal(callId:$c,toMri:$to,signal:$s)}`,
    { c: call.id, to: alice.user.mri, s: JSON.stringify({ type: "offer", sdp: "x" }) }, bob.token)).callSignal;
  await new Promise((r) => setTimeout(r, 300));
  check("call signal relayed to peer", ok && events.some((e) => e.kind === "callSignal"));
  const inCall = await gql(`query($q:String){users(search:$q){presence}}`, { q: "alice" }, bob.token);
  check("presence becomes InACall", inCall.users[0].presence === "InACall");
  await gql(`mutation($c:ID!){leaveCall(callId:$c)}`, { c: call.id }, alice.token);
  await gql(`mutation($c:ID!){leaveCall(callId:$c)}`, { c: call.id }, bob.token);
  const end = await gql(`query($t:ID!){messages(threadId:$t){messageType content}}`, { t: chat.id }, alice.token);
  check("call end posts a call event", end.messages.some((m: any) => m.messageType === "Event/Call" && m.content.startsWith("Call ended")));

  await ws.dispose();
} catch (e) {
  console.error("FAIL  smoke run threw:", e);
  failures++;
} finally {
  srv.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
