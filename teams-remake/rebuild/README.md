# Teams Rebuild

A from-scratch reimplementation of Microsoft Teams' core, built from the reverse-engineering
findings in `../notes.md`. No Microsoft code or assets are used.

## Run

```bash
npm install            # once, from this folder
npm run build          # build the client
npm run server         # http://localhost:4000  (serves the client + API)
```

For client development with hot reload, run `npm run server` and `npm run client` together, then open http://localhost:5173.

To test as two people on one machine, use two different origins (`http://localhost:4000` and `http://127.0.0.1:4000`) or a normal window plus a private window. The login token is kept per origin.

## Tests

| Command | What it proves |
|---|---|
| `npm test -w server` | API end to end: auth, chats, push, typing, unread, mentions → activity, FTS search scoping, teams/channels/replies, access control, reactions, call signalling, presence, call-ended events |
| `npm run e2e -w server` | Two headless Chrome users with a fake camera and mic drive the real UI: chat, mentions, typing, reactions, activity, team + channel threads, search, ringing, two-way video, presence, hang-up |

## How it maps to real Teams

| Real Teams (observed) | Here |
|---|---|
| WebView2 shell + React/Fluent UI SPA | React 18 + Fluent UI 9 (`teamsLightTheme` / `teamsDarkTheme`) |
| ~4,900 colocated Apollo GraphQL ops, resolved in a SharedWorker | Apollo Client → one GraphQL schema on the server (`server/src/schema.ts`) |
| Chat service model: threads / members / properties / conversations / messages, MRI ids (`8:orgid:…`), thread ids (`19:…@thread.v2`, `@thread.tacv2`) | Same model and id formats (`server/src/db.ts`) |
| Consumption horizon (read marker) | `horizons` table → unread counts |
| `<at id>` mention tags in message content | Same tags; rendered as React nodes (never as HTML) |
| `streams/notifications` (activity feed) | `activity` table: mention, reply and reaction events |
| Trouter websocket push | GraphQL `events` subscription over graphql-ws (`server/src/trouter.ts`) |
| Substrate search | SQLite FTS5 with prefix matching, scoped to your threads |
| Native SlimCore/Rtm media engine | Browser WebRTC full mesh; signalling relayed over push (`client/src/calls.ts`) |
| Team = M365 group + General channel | Team thread + auto-created General channel; channels inherit team membership |

## Not built (yet)

Microsoft sign-in, meetings with scheduling and lobby, recording, transcription and captions, apps/tabs/bots, Copilot, private and shared channels, message forwarding, read receipts per person, and an SFU/TURN for large or NAT-restricted calls. The mesh suits about 4 participants.
