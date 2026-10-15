// Calling engine. Real Teams drives a native media stack (SlimCore / Rtm*.dll) through
// the WebView2 bridge; we use browser WebRTC in a full mesh. Signalling (offer/answer/ICE)
// rides the push channel via the callSignal mutation. The newcomer always sends the offers,
// so two peers never offer to each other at once.
import { useSyncExternalStore } from "react";
import { client } from "./apollo";
import { CALL_SIGNAL, JOIN_CALL, LEAVE_CALL, START_CALL, type Call } from "./gql";
import { onPush } from "./push";

const ICE: RTCConfiguration = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

export interface CallView {
  call: Call | null;
  threadId: string | null;
  local: MediaStream | null;
  remotes: { mri: string; stream: MediaStream; state: RTCPeerConnectionState }[];
  muted: boolean;
  cameraOn: boolean;
  sharing: boolean;
  error: string | null;
}

let view: CallView = { call: null, threadId: null, local: null, remotes: [], muted: false, cameraOn: false, sharing: false, error: null };
const subs = new Set<() => void>();
const emit = (patch: Partial<CallView>) => { view = { ...view, ...patch }; subs.forEach((f) => f()); };
export const useCall = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => view);

const peers = new Map<string, { pc: RTCPeerConnection; stream: MediaStream; pendingIce: RTCIceCandidateInit[] }>();
let me = "";
let camTrack: MediaStreamTrack | null = null;
let micTrack: MediaStreamTrack | null = null;
let screenTrack: MediaStreamTrack | null = null;

export const setCallIdentity = (mri: string) => { me = mri; };

const signal = (toMri: string, s: object) =>
  view.call && client.mutate({ mutation: CALL_SIGNAL, variables: { callId: view.call.id, toMri, signal: JSON.stringify(s) } }).catch(() => {});

const currentVideo = () => screenTrack ?? (view.cameraOn ? camTrack : null);

function syncRemotes() {
  emit({ remotes: [...peers].map(([mri, p]) => ({ mri, stream: p.stream, state: p.pc.connectionState })) });
}

function makePeer(mri: string) {
  peers.get(mri)?.pc.close();
  const pc = new RTCPeerConnection(ICE);
  const stream = new MediaStream();
  const entry = { pc, stream, pendingIce: [] as RTCIceCandidateInit[] };
  peers.set(mri, entry);
  pc.onicecandidate = (e) => e.candidate && signal(mri, { type: "ice", candidate: e.candidate.toJSON() });
  pc.ontrack = (e) => {
    stream.getTracks().filter((t) => t.kind === e.track.kind).forEach((t) => stream.removeTrack(t));
    stream.addTrack(e.track);
    syncRemotes();
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") dropPeer(mri);
    else syncRemotes();
  };
  syncRemotes();
  return entry;
}

function dropPeer(mri: string) {
  const p = peers.get(mri);
  if (!p) return;
  p.pc.close();
  peers.delete(mri);
  syncRemotes();
}

/** Attach our current mic/video to a connection's audio + video transceivers. */
async function attachLocal(pc: RTCPeerConnection) {
  for (const t of pc.getTransceivers()) {
    const kind = t.receiver.track.kind;
    t.direction = "sendrecv";
    await t.sender.replaceTrack(kind === "audio" ? micTrack : currentVideo());
  }
}

async function offerTo(mri: string) {
  const { pc } = makePeer(mri);
  pc.addTransceiver("audio", { direction: "sendrecv" });
  pc.addTransceiver("video", { direction: "sendrecv" });
  await attachLocal(pc);
  await pc.setLocalDescription(await pc.createOffer());
  signal(mri, { type: "offer", sdp: pc.localDescription!.sdp });
}

async function onSignal(from: string, s: any) {
  if (!view.call || from === me) return;
  if (s.type === "offer") {
    const entry = makePeer(from);
    await entry.pc.setRemoteDescription({ type: "offer", sdp: s.sdp });
    await attachLocal(entry.pc);
    await entry.pc.setLocalDescription(await entry.pc.createAnswer());
    signal(from, { type: "answer", sdp: entry.pc.localDescription!.sdp });
    for (const c of entry.pendingIce.splice(0)) await entry.pc.addIceCandidate(c).catch(() => {});
  } else if (s.type === "answer") {
    const p = peers.get(from);
    if (p && p.pc.signalingState === "have-local-offer") {
      await p.pc.setRemoteDescription({ type: "answer", sdp: s.sdp });
      for (const c of p.pendingIce.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
    }
  } else if (s.type === "ice") {
    const p = peers.get(from);
    if (!p) return;
    if (p.pc.remoteDescription) await p.pc.addIceCandidate(s.candidate).catch(() => {});
    else p.pendingIce.push(s.candidate);
  } else if (s.type === "bye") {
    dropPeer(from);
  }
}

onPush((e) => {
  if (e.kind === "callSignal" && e.payload) {
    const { callId, from, signal: s } = JSON.parse(e.payload);
    if (view.call?.id === callId) onSignal(from, s).catch((err) => console.warn("signal failed", err));
  }
});

async function acquireMedia(video: boolean) {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    micTrack = s.getAudioTracks()[0] ?? null;
    camTrack = s.getVideoTracks()[0] ?? null;
  } catch {
    // fall back to audio-only, then to receive-only, rather than failing the call
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      micTrack = s.getAudioTracks()[0] ?? null;
      camTrack = null;
      emit({ error: video ? "Camera unavailable — joined with audio only" : null });
    } catch {
      micTrack = camTrack = null;
      emit({ error: "No microphone or camera access — you can still see and hear others" });
    }
  }
  refreshLocal(video && !!camTrack);
}

function refreshLocal(cameraOn = view.cameraOn) {
  const local = new MediaStream([micTrack, screenTrack ?? (cameraOn ? camTrack : null)].filter(Boolean) as MediaStreamTrack[]);
  emit({ local, cameraOn });
}

async function enter(call: Call) {
  emit({ call, threadId: call.threadId });
  for (const p of call.participants) if (p.mri !== me) await offerTo(p.mri);
}

export async function startCall(threadId: string, video: boolean) {
  if (view.call) return;
  emit({ threadId, error: null });
  await acquireMedia(video);
  try {
    const { data } = await client.mutate({ mutation: START_CALL, variables: { threadId, video } });
    await enter(data.startCall);
  } catch (e: any) {
    cleanup();
    emit({ error: e.message });
  }
}

export async function joinCall(callId: string, video: boolean) {
  if (view.call) return;
  emit({ error: null });
  await acquireMedia(video);
  try {
    const { data } = await client.mutate({ mutation: JOIN_CALL, variables: { callId } });
    await enter(data.joinCall);
  } catch (e: any) {
    cleanup();
    emit({ error: e.message });
  }
}

export async function leaveCall() {
  const id = view.call?.id;
  cleanup();
  if (id) await client.mutate({ mutation: LEAVE_CALL, variables: { callId: id } }).catch(() => {});
}

function cleanup() {
  for (const mri of [...peers.keys()]) dropPeer(mri);
  [micTrack, camTrack, screenTrack].forEach((t) => t?.stop());
  micTrack = camTrack = screenTrack = null;
  emit({ call: null, threadId: null, local: null, remotes: [], muted: false, cameraOn: false, sharing: false });
}

async function pushVideo() {
  for (const { pc } of peers.values())
    for (const t of pc.getTransceivers()) if (t.receiver.track.kind === "video") await t.sender.replaceTrack(currentVideo());
  refreshLocal();
}

export function toggleMute() {
  if (micTrack) micTrack.enabled = !micTrack.enabled;
  emit({ muted: !(micTrack?.enabled ?? false) });
}

export async function toggleCamera() {
  if (view.cameraOn) {
    emit({ cameraOn: false });
  } else {
    if (!camTrack || camTrack.readyState === "ended") {
      try { camTrack = (await navigator.mediaDevices.getUserMedia({ video: true })).getVideoTracks()[0]; }
      catch { emit({ error: "Camera unavailable" }); return; }
    }
    emit({ cameraOn: true });
  }
  await pushVideo();
}

export async function toggleShare() {
  if (screenTrack) {
    screenTrack.stop();
    screenTrack = null;
    emit({ sharing: false });
  } else {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenTrack = s.getVideoTracks()[0];
      screenTrack.onended = () => { if (screenTrack) toggleShare(); };
      emit({ sharing: true });
    } catch { return; }
  }
  await pushVideo();
}

window.addEventListener("beforeunload", () => { if (view.call) leaveCall(); });
