import { useMutation, useQuery } from "@apollo/client";
import {
  Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  Field, Input, MessageBar, MessageBarBody, Textarea,
} from "@fluentui/react-components";
import { SearchRegular } from "@fluentui/react-icons";
import { useState } from "react";
import { CREATE_CHANNEL, CREATE_TEAM, USERS, type User } from "../gql";
import { PersonAvatar } from "./common";

export function PeoplePicker({ open, title, action, exclude, withTopic, onClose, onPick }: {
  open: boolean; title: string; action: string; exclude: string[]; withTopic?: boolean;
  onClose: () => void; onPick: (mris: string[], topic?: string) => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<User[]>([]);
  const [topic, setTopic] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data } = useQuery(USERS, { variables: { search }, skip: !open });
  const people: User[] = (data?.users ?? []).filter((u: User) => !exclude.includes(u.mri));

  const close = () => { setSearch(""); setPicked([]); setTopic(""); setError(null); onClose(); };
  const toggle = (u: User) => setPicked((p) => (p.some((x) => x.mri === u.mri) ? p.filter((x) => x.mri !== u.mri) : [...p, u]));

  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && close()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent className="dialog-stack">
            {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
            {withTopic && picked.length > 1 && (
              <Field label="Group name (optional)"><Input value={topic} onChange={(_, d) => setTopic(d.value)} /></Field>
            )}
            <Input contentBefore={<SearchRegular />} placeholder="Search by name or email" value={search}
              onChange={(_, d) => setSearch(d.value)} autoFocus />
            {picked.length > 0 && <div className="muted">Selected: {picked.map((p) => p.displayName).join(", ")}</div>}
            <div className="people-list">
              {people.length === 0 && <div className="muted">No people found. Ask them to create an account first.</div>}
              {people.map((u) => (
                <label key={u.mri} className="people-row">
                  <Checkbox checked={picked.some((p) => p.mri === u.mri)} onChange={() => toggle(u)} />
                  <PersonAvatar user={u} size={28} />
                  <span><strong>{u.displayName}</strong><br /><span className="muted">{u.email}</span></span>
                </label>
              ))}
            </div>
          </DialogContent>
          <DialogActions>
            <Button onClick={close}>Cancel</Button>
            <Button appearance="primary" disabled={!picked.length || busy} onClick={async () => {
              setBusy(true);
              try { await onPick(picked.map((p) => p.mri), topic || undefined); close(); }
              catch (e: any) { setError(e.message); }
              finally { setBusy(false); }
            }}>{action}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export function NameDialog({ open, title, label, action, withDescription, onClose, onSubmit }: {
  open: boolean; title: string; label: string; action: string; withDescription?: boolean;
  onClose: () => void; onSubmit: (name: string, description: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const close = () => { setName(""); setDescription(""); setError(null); onClose(); };
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && close()}>
      <DialogSurface>
        <form onSubmit={async (e) => {
          e.preventDefault();
          try { await onSubmit(name, description); close(); } catch (err: any) { setError(err.message); }
        }}>
          <DialogBody>
            <DialogTitle>{title}</DialogTitle>
            <DialogContent className="dialog-stack">
              {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
              <Field label={label} required><Input value={name} onChange={(_, d) => setName(d.value)} autoFocus /></Field>
              {withDescription && (
                <Field label="Description"><Textarea value={description} onChange={(_, d) => setDescription(d.value)} /></Field>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={close}>Cancel</Button>
              <Button appearance="primary" type="submit" disabled={!name.trim()}>{action}</Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}

export function useCreateTeam() {
  const [m] = useMutation(CREATE_TEAM, { refetchQueries: ["Teams"] });
  return (name: string, description: string) => m({ variables: { name, description: description || null } });
}
export function useCreateChannel() {
  const [m] = useMutation(CREATE_CHANNEL, { refetchQueries: ["Teams"] });
  return (teamId: string, name: string, description: string) => m({ variables: { teamId, name, description: description || null } });
}
