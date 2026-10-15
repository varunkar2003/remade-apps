import { gql } from "@apollo/client";

export const USER = gql`fragment UserFields on User { mri displayName email presence }`;

const MESSAGE_BODY = gql`
  ${USER}
  fragment MessageBody on Message {
    id threadId parentId messageType subject content createdAt editedAt deleted replyCount
    from { ...UserFields }
    reactions { emoji count reactedByMe users { mri displayName } }
    mentions { mri displayName }
    files { id name size mime url }
  }`;

export const MESSAGE = gql`
  ${MESSAGE_BODY}
  fragment MessageFields on Message { ...MessageBody replies { ...MessageBody } }`;

export const THREAD = gql`
  ${USER}
  fragment ThreadFields on Thread {
    id type topic description isGeneral lastActivityAt unreadCount myRole
    members { ...UserFields }
    lastMessage { id content messageType createdAt deleted from { mri displayName } }
    activeCall { id threadId video startedAt participants { mri displayName } }
  }`;

export interface User { mri: string; displayName: string; email: string; presence: string }
export interface FileRef { id: string; name: string; size: number; mime: string; url: string }
export interface Message {
  id: string; threadId: string; parentId: string | null; messageType: string; subject: string | null; content: string;
  createdAt: number; editedAt: number | null; deleted: boolean; replyCount: number; from: User | null;
  reactions: { emoji: string; count: number; reactedByMe: boolean; users: { mri: string; displayName: string }[] }[];
  mentions: { mri: string; displayName: string }[]; files: FileRef[]; replies?: Message[];
}
export interface Call { id: string; threadId: string; video: boolean; startedAt: number; participants: { mri: string; displayName: string }[] }
export interface Thread {
  id: string; type: "chat" | "team" | "channel"; topic: string | null; description: string | null; isGeneral: boolean;
  lastActivityAt: number; unreadCount: number; myRole: string | null; members: User[];
  lastMessage: Pick<Message, "id" | "content" | "messageType" | "createdAt" | "deleted"> & { from: { mri: string; displayName: string } | null } | null;
  activeCall: Call | null; channels?: Thread[]; team?: Thread | null;
}

export const ME = gql`${USER} query Me { me { ...UserFields } }`;
export const SIGNUP = gql`${USER} mutation Signup($email: String!, $displayName: String!, $password: String!) {
  signup(email: $email, displayName: $displayName, password: $password) { token user { ...UserFields } } }`;
export const LOGIN = gql`${USER} mutation Login($email: String!, $password: String!) {
  login(email: $email, password: $password) { token user { ...UserFields } } }`;
export const SET_PRESENCE = gql`${USER} mutation SetPresence($presence: Presence) { setPresence(presence: $presence) { ...UserFields } }`;
export const USERS = gql`${USER} query Users($search: String) { users(search: $search) { ...UserFields } }`;

export const CHATS = gql`${THREAD} query Chats { chats { ...ThreadFields } }`;
export const TEAMS = gql`${THREAD} query Teams { teams { ...ThreadFields channels { ...ThreadFields } } }`;
export const THREAD_Q = gql`${THREAD} query Thread($id: ID!) { thread(id: $id) { ...ThreadFields team { id topic } } }`;
export const MESSAGES = gql`${MESSAGE} query Messages($threadId: ID!, $before: Float) {
  messages(threadId: $threadId, before: $before, limit: 50) { ...MessageFields } }`;
export const MESSAGE_Q = gql`${MESSAGE} query Message($id: ID!) { message(id: $id) { ...MessageFields } }`;
export const ACTIVITY = gql`query Activity { activity(limit: 100) {
  id kind preview createdAt read messageId actor { mri displayName presence email } thread { id type topic team { id topic } } } }`;
export const SEARCH = gql`query Search($q: String!) { search(q: $q) {
  snippet message { id createdAt parentId from { mri displayName } } thread { id type topic team { id topic } } } }`;
export const ACTIVE_CALLS = gql`query ActiveCalls { activeCalls { id threadId video startedAt participants { mri displayName } } }`;

export const CREATE_CHAT = gql`${THREAD} mutation CreateChat($memberMris: [ID!]!, $topic: String) {
  createChat(memberMris: $memberMris, topic: $topic) { ...ThreadFields } }`;
export const ADD_MEMBERS = gql`${THREAD} mutation AddMembers($threadId: ID!, $memberMris: [ID!]!) {
  addMembers(threadId: $threadId, memberMris: $memberMris) { ...ThreadFields } }`;
export const RENAME = gql`mutation Rename($threadId: ID!, $topic: String!) { renameThread(threadId: $threadId, topic: $topic) { id topic } }`;
export const CREATE_TEAM = gql`${THREAD} mutation CreateTeam($name: String!, $description: String) {
  createTeam(name: $name, description: $description) { ...ThreadFields channels { ...ThreadFields } } }`;
export const CREATE_CHANNEL = gql`${THREAD} mutation CreateChannel($teamId: ID!, $name: String!, $description: String) {
  createChannel(teamId: $teamId, name: $name, description: $description) { ...ThreadFields } }`;

export const SEND = gql`${MESSAGE} mutation Send($threadId: ID!, $content: String!, $parentId: ID, $subject: String, $mentionMris: [ID!], $fileIds: [ID!]) {
  sendMessage(threadId: $threadId, content: $content, parentId: $parentId, subject: $subject, mentionMris: $mentionMris, fileIds: $fileIds) { ...MessageFields } }`;
export const EDIT = gql`${MESSAGE} mutation Edit($id: ID!, $content: String!) { editMessage(id: $id, content: $content) { ...MessageFields } }`;
export const DELETE = gql`${MESSAGE} mutation Delete($id: ID!) { deleteMessage(id: $id) { ...MessageFields } }`;
export const REACT = gql`${MESSAGE} mutation React($messageId: ID!, $emoji: String!) { toggleReaction(messageId: $messageId, emoji: $emoji) { ...MessageFields } }`;
export const MARK_READ = gql`mutation MarkRead($threadId: ID!) { markRead(threadId: $threadId) { id unreadCount } }`;
export const MARK_ACTIVITY_READ = gql`mutation { markActivityRead }`;
export const TYPING = gql`mutation Typing($threadId: ID!) { setTyping(threadId: $threadId) }`;

export const START_CALL = gql`mutation StartCall($threadId: ID!, $video: Boolean!) { startCall(threadId: $threadId, video: $video) { id threadId video startedAt participants { mri displayName } } }`;
export const JOIN_CALL = gql`mutation JoinCall($callId: ID!) { joinCall(callId: $callId) { id threadId video startedAt participants { mri displayName } } }`;
export const LEAVE_CALL = gql`mutation LeaveCall($callId: ID!) { leaveCall(callId: $callId) }`;
export const DECLINE_CALL = gql`mutation DeclineCall($callId: ID!) { declineCall(callId: $callId) }`;
export const CALL_SIGNAL = gql`mutation CallSignal($callId: ID!, $toMri: ID!, $signal: String!) { callSignal(callId: $callId, toMri: $toMri, signal: $signal) }`;

export const EVENTS = gql`${MESSAGE} ${USER} subscription Events { events {
  kind threadId messageId mri payload
  message { ...MessageFields }
  user { ...UserFields }
  call { id threadId video startedAt participants { mri displayName } }
} }`;
