# Cursor — reverse-engineering notes

Target: Cursor 1.7.46 (commit b9e5948, 2025-10-14), fork of VS Code 1.99.3, `C:\Program Files\cursor`.
Copied to `target/`: `extensions/cursor-*`, `out/main.js`, `out/vs/workbench/workbench.desktop.main.js` (24 MB), product/package.json.

Legend: **[O]** observed in shipped files · **[I]** inference · **[?]** unknown

## 1. Architecture
| Layer | What | Evidence |
|---|---|---|
| Shell | Electron + VS Code 1.99.3 workbench, unpacked `resources/app/out` | [O] product.json |
| AI UI (chat/agent/Cmd+K/Tab) | Compiled into `workbench.desktop.main.js` (Cursor patches VS Code's workbench, not an extension) | [O] service + enum names in bundle |
| Cursor extensions | `cursor-retrieval` (indexing + retrieval, with a worker), `cursor-shadow-workspace`, `cursor-always-local` (experiments, "rcp-server", git commit messages), `cursor-file-service`, `cursor-mcp`, `cursor-deeplink`, `cursor-browser-automation/-connect`, `cursor-playwright` | [O] package.json |
| Backend | Connect-RPC (gRPC over HTTP) services `aiserver.v1.*` at `api2/api3/api4.cursor.sh`; repo index at `repo42.cursor.sh` | [O] |

REA: `analyze_javascript_application` on extensions → 38 JS files, 2,040 modules (ev_269e7c15bf2f6645fd9da8da0631c2d614fc5b3015a5e4d20c70e3fed6dcca16). Deep semantic graphs incomplete for retrieval / shadow-workspace / always-local (size budget, stack depth); static and module facts retained.

## 2. Backend services → features [O names, I mapping]
| Feature | Service.methods |
|---|---|
| Chat / Agent / Composer | `ChatService.StreamUnifiedChatWithTools` (+SSE, Poll, Warm, `GetConversationSummary`, `StreamSpeculativeSummaries`) — one streaming RPC; tool calls round-trip to the client |
| Cmd+K inline edit | `CmdKService.StreamCmdK`, `StreamTerminalCmdK`, `RerankCmdKContext`, `StreamHypermode`; full-file variant `ChatService.StreamFullFileCmdK` |
| Tab (autocomplete) | `CppService` ("Copilot++"), `StreamHoldCpp`, `RecordCppFate` (accept/reject telemetry) |
| Next-cursor prediction | `CursorPredictionService` |
| Apply edits | `FastApplyService` (`WarmApply`, `ReportEditFate`) — a dedicated fast "apply" model merges the LLM's sketch edit into the file [I] |
| Codebase index | `RepositoryService`: `FastRepoInitHandshake(V2)` → `SyncMerkleSubtree(V2)` → `FastUpdateFile(V2)`; `SemSearch`/`SemSearchFast`; `GetEmbeddings`; PR history indexing |
| Lint-checked agent edits | `ShadowWorkspaceService`: `GetLintsForChange`, `SwWriteTextFileWithLints`, `SwGetLinterErrors` |
| Other | `BugbotService` (PR review), `FastSearchService`, `MCPRegistryService`, `ReviewService`, `GitGraphService`, metrics/telemetry services |

## 3. Agent [O]
- Modes: `UNIFIED_MODE_AGENT`, `_CHAT` (Ask), `_EDIT` (Manual), `_PLAN`, `_CUSTOM`; plus Background agents.
- Client-side tools (`CLIENT_SIDE_TOOL_V2_*`): READ_FILE(_V2), EDIT_FILE(_V2), DELETE_FILE, LIST_DIR(_V2), FILE_SEARCH, GLOB_FILE_SEARCH, RIPGREP_SEARCH, RIPGREP_RAW_SEARCH, SEMANTIC_SEARCH_FULL, READ_SEMSEARCH_FILES, DEEP_SEARCH, SEARCH_SYMBOLS, GO_TO_DEFINITION, RUN_TERMINAL_COMMAND_V2, READ_LINTS, FIX_LINTS, REAPPLY, TODO_READ, TODO_WRITE, CREATE_PLAN, TASK / AWAIT_TASK (subagents), FETCH_RULES, KNOWLEDGE_BASE, WEB_SEARCH, MCP, LIST_MCP_RESOURCES, READ_MCP_RESOURCE, FETCH_PULL_REQUEST, CREATE_DIAGRAM, BACKGROUND_COMPOSER_FOLLOWUP.
- → The model runs server-side; the tool **executes on the client** and results stream back.

## 4. Indexing (cursor-retrieval) [O keywords, I mechanism]
- Respects `.cursorignore` and `.cursorindexingignore`.
- Files hashed with SHA-256 into a **Merkle tree**; client and server compare subtrees so only changed files are re-sent.
- Chunking with **tree-sitter** (syntax-aware chunks), **simhash** for near-duplicates.
- **Paths encrypted/obfuscated** (`encryptPath`, `path_key`) before upload; embeddings computed server-side; semantic search returns chunk references and the client reads the file contents locally.

## 5. Open questions
- [?] Exact prompt format and context assembly (server-side, not observable statically)
- [?] Tab model's inputs (diff history, cursor context) — would need runtime capture of our own session

## 6. Rebuild
See `rebuild/README.md`. Built 2026-10-15: Electron + React + Monaco + Claude (`claude-opus-5-5`).
Verified: `npm run typecheck` clean, `npm test` 14/14, `npm run e2e` 15/15 (against a scripted fake Messages API — real-model quality not yet exercised; no Anthropic key on this machine).
