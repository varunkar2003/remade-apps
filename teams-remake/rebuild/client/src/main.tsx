import { ApolloProvider } from "@apollo/client";
import { FluentProvider, teamsDarkTheme, teamsLightTheme } from "@fluentui/react-components";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { client } from "./apollo";
import { App } from "./App";
import "./app.css";

function Root() {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const [dark, setDark] = useState(mq.matches);
  useEffect(() => {
    const f = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, [mq]);
  return (
    <FluentProvider theme={dark ? teamsDarkTheme : teamsLightTheme} className="fluent-root">
      <ApolloProvider client={client}><App /></ApolloProvider>
    </FluentProvider>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
