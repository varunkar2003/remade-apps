import { useApolloClient, useMutation } from "@apollo/client";
import { Button, Tooltip } from "@fluentui/react-components";
import {
  CallEndRegular, CallRegular, MicOffRegular, MicRegular, ShareScreenStartRegular, ShareScreenStopRegular,
  VideoOffRegular, VideoRegular,
} from "@fluentui/react-icons";
import { useEffect, useRef, useState } from "react";
import { joinCall, leaveCall, toggleCamera, toggleMute, toggleShare, useCall } from "../calls";
import { DECLINE_CALL, THREAD_Q, type User } from "../gql";
import { onPush } from "../push";
import { PersonAvatar } from "./common";

function Tile({ stream, name, muted, mirrored, user }: {
  stream: MediaStream | null; name: string; muted?: boolean; mirrored?: boolean; user?: Partial<User>;
}) {
  const v = useRef<HTMLVideoElement>(null);
  const a = useRef<HTMLAudioElement>(null);
  const [hasVideo, setHasVideo] = useState(false);
  useEffect(() => {
    if (v.current) v.current.srcObject = stream;
    if (a.current && !muted) a.current.srcObject = stream;
    const check = () => setHasVideo(!!stream?.getVideoTracks().some((t) => t.readyState === "live" && !t.muted));
    check();
    const tracks = stream?.getVideoTracks() ?? [];
    tracks.forEach((t) => { t.addEventListener("mute", check); t.addEventListener("unmute", check); });
    stream?.addEventListener("addtrack", check);
    const iv = setInterval(check, 1000);
    return () => { clearInterval(iv); tracks.forEach((t) => { t.removeEventListener("mute", check); t.removeEventListener("unmute", check); }); };
  }, [stream, muted]);
  return (
    <div className="tile">
      <video ref={v} autoPlay playsInline muted className={mirrored ? "mirrored" : ""} style={{ display: hasVideo ? "block" : "none" }} />
      {!muted && <audio ref={a} autoPlay />}
      {!hasVideo && <div className="tile-avatar"><PersonAvatar user={{ displayName: name, ...user }} size={96} presence={false} /></div>}
      <span className="tile-name">{name}</span>
    </div>
  );
}

export function CallStage({ me, meName, names }: { me: string; meName: string; names: Map<string, string> }) {
  const c = useCall();
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!c.call) return;
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - c.call!.startedAt) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [c.call]);
  if (!c.call) return c.error ? <div className="call-error" role="alert">{c.error}</div> : null;
  const n = c.remotes.length + 1;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
  const fmt = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  return (
    <section className="call-stage" aria-label="Call">
      <div className="call-top"><span className="call-dot" /> {fmt} {c.error && <span className="muted"> · {c.error}</span>}</div>
      <div className="call-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {c.remotes.length === 0 && <div className="call-waiting muted">Waiting for others to join…</div>}
        {c.remotes.map((r) => (
          <Tile key={r.mri} stream={r.stream} name={`${names.get(r.mri) ?? "Participant"}${r.state === "connected" ? "" : " · connecting"}`} />
        ))}
        <Tile stream={c.local} name={`${meName} (You)`} muted mirrored={!c.sharing} />
      </div>
      <div className="call-controls">
        <Tooltip content={c.muted ? "Unmute" : "Mute"} relationship="label">
          <Button shape="circular" size="large" icon={c.muted ? <MicOffRegular /> : <MicRegular />} onClick={toggleMute} aria-pressed={c.muted} />
        </Tooltip>
        <Tooltip content={c.cameraOn ? "Turn camera off" : "Turn camera on"} relationship="label">
          <Button shape="circular" size="large" icon={c.cameraOn ? <VideoRegular /> : <VideoOffRegular />} onClick={toggleCamera} />
        </Tooltip>
        <Tooltip content={c.sharing ? "Stop sharing" : "Share screen"} relationship="label">
          <Button shape="circular" size="large" icon={c.sharing ? <ShareScreenStopRegular /> : <ShareScreenStartRegular />} onClick={toggleShare} />
        </Tooltip>
        <Tooltip content="Leave" relationship="label">
          <Button shape="circular" size="large" className="hangup" icon={<CallEndRegular />} onClick={leaveCall} />
        </Tooltip>
      </div>
    </section>
  );
}

/** Ring for incoming 1:1 / group chat calls (channel meetings don't ring). */
export function IncomingCall({ me }: { me: string }) {
  const client = useApolloClient();
  const call = useCall();
  const [ring, setRing] = useState<{ callId: string; threadId: string; from: string; title: string } | null>(null);
  const [decline] = useMutation(DECLINE_CALL);

  useEffect(() => onPush(async (e) => {
    if (e.kind !== "callUpdated" || !e.payload) return;
    const p = JSON.parse(e.payload);
    if (p.ended) { setRing((r) => (r?.callId === p.id ? null : r)); return; }
    if (!p.ring || e.mri === me || call.call) return;
    const { data } = await client.query({ query: THREAD_Q, variables: { id: e.threadId }, fetchPolicy: "cache-first" });
    if (data.thread.type !== "chat") return;
    const from = data.thread.members.find((m: User) => m.mri === e.mri)?.displayName ?? "Someone";
    setRing({ callId: p.id, threadId: e.threadId!, from, title: data.thread.topic ?? "" });
  }), [me, call.call, client]);

  useEffect(() => {
    if (!ring) return;
    const t = setTimeout(() => setRing(null), 30000);
    return () => clearTimeout(t);
  }, [ring]);
  useEffect(() => { if (call.call) setRing(null); }, [call.call]);

  if (!ring) return null;
  return (
    <div className="incoming" role="alertdialog" aria-label={`Incoming call from ${ring.from}`}>
      <PersonAvatar user={{ displayName: ring.from }} size={48} presence={false} />
      <div><strong>{ring.from}</strong><div className="muted">{ring.title ? `Calling ${ring.title}` : "is calling you"}</div></div>
      <Tooltip content="Accept with video" relationship="label">
        <Button shape="circular" className="accept" icon={<VideoRegular />} onClick={() => { joinCall(ring.callId, true); setRing(null); }} />
      </Tooltip>
      <Tooltip content="Accept with audio" relationship="label">
        <Button shape="circular" className="accept" icon={<CallRegular />} onClick={() => { joinCall(ring.callId, false); setRing(null); }} />
      </Tooltip>
      <Tooltip content="Decline" relationship="label">
        <Button shape="circular" className="hangup" icon={<CallEndRegular />} onClick={() => { decline({ variables: { callId: ring.callId } }); setRing(null); }} />
      </Tooltip>
    </div>
  );
}
