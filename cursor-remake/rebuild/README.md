# Cursor Remake

An AI code editor rebuilt from scratch, based on the reverse-engineering notes in `../notes.md`.
No Cursor code is used. The AI runs on Claude through the official Anthropic SDK.

## Run

```bash
npm install
npm run build
npm start                     # opens the editor
```

Add your Anthropic API key in **Settings** (Ctrl+,). It's encrypted with the OS keychain via Electron `safeStorage`. Alternatively, set `ANTHROPIC_API_KEY`. The default model is `claude-opus-5-5`, and you can change it in Settings.

## Features

| Feature | How it works | Cursor equivalent (observed) |
|---|---|---|
| Agent chat | Streaming tool loop with Claude; tools run locally: read/list/grep/file search/codebase search/edit/write/delete/terminal/todos | `ChatService.StreamUnifiedChatWithTools` + `CLIENT_SIDE_TOOL_V2_*` |
| Ask mode | Same loop with read-only tools | `UNIFIED_MODE_CHAT` |
| Command approval | Every terminal command waits for Run/Skip | `RUN_TERMINAL_COMMAND_V2` approval |
| Review changes | Every file the agent touches is checkpointed; diff view, accept/reject per file or all | Composer review / "Accept all" |
| Ctrl+K inline edit | Selection + instruction → replacement → inline diff → Accept/Reject (undoable) | `CmdKService.StreamCmdK` |
| Tab completion | Ghost-text suggestions at the cursor, Tab to accept, toggle in the status bar | `CppService` ("Cursor Tab") |
| Codebase index | SHA-256 Merkle tree (re-index only re-chunks changed subtrees) + declaration-aware chunking + BM25 ranking | `RepositoryService` Merkle sync + server-side embeddings |
| Ignore files | `.gitignore` + `.cursorignore` (tree, search, AI); `.cursorindexingignore` (index only) | same files |
| Project rules | `.cursorrules`, `AGENTS.md`, `.cursor/rules/*.md(c)` go into the system prompt | `FETCH_RULES` |
| @-mentions, Ctrl+L | Attach files or the current selection to a chat message | same |
| Editor | Monaco with tabs, Ctrl+P quick open, Ctrl+Shift+F search (ripgrep), terminal panel (Ctrl+`) | VS Code workbench |

The code is split in two. The main process (`src/main`) owns the filesystem, ripgrep, the index, the API key and every Claude call. The renderer (`src/renderer`) is sandboxed and reaches the main process only through the `window.api` bridge in `src/preload`. Every path from the UI or the model is confined to the open folder.

## Tests

| Command | Proves |
|---|---|
| `npm test` | Path confinement, ignore rules, ripgrep, Merkle diff + BM25, the full agent loop (search → read → edit → create → approved command), rules + eager tool streaming + fallbacks sent to the API, reject/restore, declined commands, Ask-mode tool filtering, Cmd+K, Tab |
| `npm run e2e` | Launches the real Electron app (Playwright) and covers: tree, Monaco, save, quick open, Ctrl+K, Tab ghost text, agent with approval, live tab reload, review diff with reject/accept, Ask mode, @-mentions, search, terminal, encrypted key storage, no renderer errors |

Both suites run against `test/fake-anthropic.ts`, a scripted local server that speaks the real Messages API streaming format, so no API key or spend is needed. **They don't prove output quality with a real model.** Do that by adding your key and using the app.

## Not built

VS Code extensions, debugger, git UI, language servers beyond Monaco's built-ins, embeddings (BM25 stands in), background/cloud agents, MCP, multi-root workspaces, and a real PTY terminal (the panel runs one command at a time).
