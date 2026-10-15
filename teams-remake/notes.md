# Microsoft Teams (new) — reverse-engineering notes

Target: MSTeams 26246.1604.5133.838 x64 (MSIX), `C:\Program Files\WindowsApps\MSTeams_26246.1604.5133.838_x64__8wekyb3d8bbwe`
Local copy of JS/config: `target/package/` (desktop-assets, client-bindings, AppxManifest.xml, configuration.json; .gz decompressed).

Legend: **[O]** observed in shipped files · **[I]** inference · **[?]** unknown

## 1. Architecture (layers)

| Layer | What | Evidence |
|---|---|---|
| Native shell | `ms-teams.exe` — C++ host using WebView2 (`WebView2Loader.dll`, `Microsoft.Web.WebView2.Core.winmd`) + Windows App SDK (push notifications, badges, app lifecycle, OAuth) | [O] package listing |
| Web UI | React-style SPA served from `desktop-assets/hashed-assets` (thousands of content-hashed bundles + `unhashed-assets/index.html`), plus web workers (`workers/`: editor index readjuster, telemetry, generic) | [O] |
| Cloud configs | `serve-configs/*.json` and `maglev-configs/*.json`, one per cloud: work, life (consumer), gcch, dod, gallatin (China/21Vianet), ag08/ag09 (air-gapped), bleu, delos (sovereign) | [O] filenames |
| Native↔JS bridge | `client-bindings/*.js` (~3.5 MB): `bundle.js`, `bundletrusted.js`, `rt_js_bindings_bundle.js`, `scwv2_bundle*.js` (SlimCore-for-WebView2), `calling_electron_bundle.js`, `scpie_vdi_*` (VDI media redirection) | [O] |
| Media engine | `SlimCV.dll`, `SlimCoreWebview2.dll`, `RTMPLTFM.dll`, `RtmCodecs/Control/MediaManager/Pal.dll` — native real-time media stack (Skype lineage "SlimCore"), not browser WebRTC | [O] names; [I] Skype lineage |
| Updater / autostart | `ms-teamsupdate.exe` (COM servers for updater + ECS config task), `msteams_autostarter.exe` | [O] manifest |
| Sandbox | Second app id `MSTeamsRemoteModuleContainer` runs `ms-teams.exe` in an AppContainer (partial trust) — likely isolates 3rd-party/remote modules | [O] manifest; [I] purpose |

## 2. OS integration [O] AppxManifest
- URL protocols: `msteams`, `web+msteams`, `msteamscanary`, `sip`, `sips`, `tel`, `callto`, `im`, `action-sip`, `action-schedule`
- Toast activation COM server (CLSID 816EB0E0-…), share target, Office integration COM server
- Device caps: microphone, webcam, bluetooth, HID, USB, location, radios, wiFiControl

## 3. Web app (desktop-assets) [O]
- 7,044 files / 905 MB decompressed; 6,902 JS. `index.html` loads `runtime` → `main` → ~14 shared chunks → `async-entry` from `[[staticsPath]]/teams-modular-packages/hashed-assets/` (placeholder filled by host, so the same build can be served locally or from CDN). Webpack/Rspack chunking, content-hashed.
- Stack (from bundle names): React + react-dom, Fluent UI (Griffel CSS-in-JS), **Apollo GraphQL** (+ apollo-devtools), MSAL (auth), Zod, Fluid Framework (Loop), CodeMirror.
- **Data layer runs in a SharedWorker** (`precompiled-shared-worker-*.js`, ~17 MB ×2) — UI thread renders, worker owns services/cache/network. [I: "Teams 2.1" architecture]
- **Everything is GraphQL on the client**: 4,943 named operations (2,444 queries, 1,933 mutations, 566 subscriptions), named `<Area><Component><Op>` → colocated per component. Biggest domains: Calling 907, Apps 847, Meetings 573, Settings 500, Chat 454, Channels 371, Messages 346, Copilot 214. Full list: scratchpad `gql_ops.txt` (regenerate with grep). [I] GraphQL is resolved locally in the worker against REST backends, not a single GraphQL server.
- Web workers: editor index readjuster, telemetry, WebRTC, wasmcv (WASM computer vision — background blur/effects), pluginless encoded-streams (media in browser mode).

## 4. Backend services (worker URLs + CSP) [O]
| Service | Host | Role [I] |
|---|---|---|
| Chat service (IC3, Skype lineage) | token aud `ic3.teams.office.com` [O]; host region-resolved at runtime [?] | messages, threads, members, endpoints |
| Chat service aggregator | `chatsvcagg.teams.microsoft.com`, `teams.microsoft.com/api/csa` | team/channel/chat list sync |
| Middle tier | `mtsvc.fl.teams.microsoft.com`, `teams.microsoft.com/api/mt` | people, tenant, misc |
| Auth | `teams.microsoft.com/api/authsvc`, `teams.live.com/api/auth`, MSAL / AAD | token exchange (skype token) |
| Push | `go.trouter.teams.microsoft.com/v4/a`, `wss://*.trouter.teams.microsoft.com` | **Trouter**: websocket push for new messages/presence/calls |
| Registrar | `teams.microsoft.com/registrar/prod` | register endpoint for push |
| Presence | `v1/presence/getpresence/`, `v1/pubsub/subscriptions/` | presence fetch + subscribe |
| Groups/Teams | `groupssvc.fl.teams.microsoft.com` | team membership (M365 Groups) |
| Search | `substrate.office.com/search/api` | unified search |
| Graph | `graph.microsoft.com` | files, calendar, users |
| People cards | `loki.delve.office.com` | profile cards |
| Real-time AI/editor | `wss://augloop.office.com` | AugLoop (editor assistance/Copilot) |
| Captions | `wss://*.cts.speech.microsoft.com` | live transcription |
| Live events | `wss://*.attend.teams.microsoft.com`, `*.ecdn.teams.microsoft.com`, peer5 | town halls + P2P eCDN video |
| Telemetry | `teams.events.data.microsoft.com/OneCollector/1.0` | Aria/1DS |
| Cloud selection | `serve-configs/<cloud>.json` | per-cloud CSP + headers (work, life, gcch, dod, gallatin, ag08/09, bleu, delos) |

Chat REST model (paths in worker) [O]:
`v1/users/ME/conversations` · `…/conversations/{id}` · `…/conversations/ALL/messages` · `v1/threads` · `v1/threads/{id}/members[/{mri}]` · `v1/threads/{id}/properties` · `v2/users/ME/endpoints` · `v1/users/ME/properties` · `v1/users/ME/drafts` · `v1/users/ME/streams/notifications/messages` · `…/streams/calllogs/messages` · join invitations/requests, blocklist, report.
→ Model: **thread** (chat/channel/meeting) has **members** + **properties**; user sees threads as **conversations**; **messages** live in conversations; "streams" are special system conversations (activity feed, call log). Users identified by **MRI** (`8:orgid:<guid>`).

## 5. Native ↔ web bridge ("PIE") [O]
- `client-bindings/bundle.js`: RPC over WebView2 — async `chrome.webview.postMessage`, sync `hostObjects.sync.piehostbridge.invokeSync(JSON)`. API: `invokeOnHost`, `invokeOnHostSync`, `registerForEvent`, `registerForInvokable`, namespace versioning, batching, timeouts, abandoned-call tracking.
- REA (ev_91736949462bbeb6f0da5435c4e8bd0a2258efeac8f09bd21cca41f6c66b2fb1): 9 files, 218 modules, **0 Electron IPC/preload/contextBridge**, 0 direct network requests → bridge is pure RPC relay. Two bundles (`scwv2_bundle.js`, `scpie_vdi_sc_bundle.js`) only partially graphed (size budget).
- `scwv2_bundle*.js` = SlimCore-for-WebView2: calling/media control routed to native `SlimCore`/`Rtm*` DLLs.
- App-level module namespaces (`namespace:"…"` in web app): esp, simpleCollab, extensibility, teamsAndChannels, calling, messaging, chatList, channels, activity, toastNotifications, people, compose, search, calendar, files, meetingOptions, breakoutRooms, webinar, customCopilot, … (~60+).

## 6. Rebuild
See `rebuild/README.md`. Phase 1 (core + calls) built 2026-10-15; `npm test -w server` 19/19 and `npm run e2e -w server` 13/13 steps passing.

## 7. Open questions
- [?] Exact message JSON schema (need runtime capture of `conversations/{id}/messages` — would require signed-in session; HAR of our own account is OK)
- [?] Trouter wire protocol details
- [?] Calling signalling (needs native analysis of SlimCore → Ghidra not installed)
