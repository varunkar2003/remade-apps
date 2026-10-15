import { useMutation } from "@apollo/client";
import { Button, Field, Input, Link, MessageBar, MessageBarBody, Spinner } from "@fluentui/react-components";
import { useState, type FormEvent } from "react";
import { setToken } from "../apollo";
import { LOGIN, SIGNUP } from "../gql";

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [login, l] = useMutation(LOGIN);
  const [signup, s] = useMutation(SIGNUP);
  const error = (mode === "login" ? l.error : s.error)?.message;
  const busy = l.loading || s.loading;

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const { data } = mode === "login"
        ? await login({ variables: { email, password } })
        : await signup({ variables: { email, displayName: name, password } });
      setToken((data.login ?? data.signup).token);
      onSignedIn();
    } catch { /* shown via error */ }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo" aria-hidden>T</div>
        <h1>{mode === "login" ? "Sign in" : "Create your account"}</h1>
        <p className="muted">Teams Rebuild — a from-scratch reimplementation for learning.</p>
        {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
        {mode === "signup" && (
          <Field label="Name"><Input value={name} onChange={(_, d) => setName(d.value)} autoComplete="name" required /></Field>
        )}
        <Field label="Email"><Input type="email" value={email} onChange={(_, d) => setEmail(d.value)} autoComplete="email" required /></Field>
        <Field label="Password">
          <Input type="password" value={password} onChange={(_, d) => setPassword(d.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"} required />
        </Field>
        <Button appearance="primary" type="submit" disabled={busy}>
          {busy ? <Spinner size="tiny" /> : mode === "login" ? "Sign in" : "Create account"}
        </Button>
        <p className="muted">
          {mode === "login" ? "New here? " : "Already have an account? "}
          <Link as="button" type="button" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
            {mode === "login" ? "Create an account" : "Sign in"}
          </Link>
        </p>
      </form>
    </div>
  );
}
