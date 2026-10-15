# Remade Apps

Four well-known apps rebuilt from scratch, after studying how the originals work with
[REA (Reverse Engineer Anything)](https://github.com/morluto/rea). Each folder has:

- `notes.md`: what the original is made of and the evidence behind each finding
- `rebuild/`: our own implementation, with its README and tests

| Folder | Original | Remake | Stack |
|---|---|---|---|
| [`teams-remake`](teams-remake) | Microsoft Teams | Chat, teams/channels with threaded posts, real-time push, presence, mentions, reactions, files, activity feed, search, audio/video calls with screen share | React + Fluent UI + Apollo GraphQL · Node + graphql-ws + SQLite · WebRTC |
| [`cursor-remake`](cursor-remake) | Cursor | AI code editor: Agent/Ask chat with tools, change review (accept/reject), Ctrl+K inline edit, Tab completion, codebase index, project rules | Electron + Monaco + React · Claude API |
| [`clipchamp-remake`](clipchamp-remake) | Microsoft Clipchamp | In-browser video editor: multi-track timeline, WebGL effects and transitions, titles, audio mix, MP4 export, local storage | React + WebGL2 + WebCodecs + OPFS |
| [`movavi-remake`](movavi-remake) | Movavi Video Editor | Desktop video editor on FFmpeg: any-format import, 16 GPU effects (chroma key, LUT, VHS…), 19 transitions, Pan & Zoom, silence removal, beat markers, magnetic timeline, hardware-accelerated export | Electron + FFmpeg + WebGL2 |

## Quick start

```bash
cd teams-remake/rebuild     && npm install && npm run build && npm run server   # http://localhost:4000
cd clipchamp-remake/rebuild && npm install && npm run dev                        # http://localhost:5173
cd cursor-remake/rebuild    && npm install && npm run build && npm start
cd movavi-remake/rebuild    && npm install && npm run build && npm start
```

Every remake ships automated tests: API/engine tests plus end-to-end tests that drive the real UI with Playwright. See each `rebuild/README.md`.

## Disclaimer

These are independent, educational reimplementations. They contain no code, assets or binaries from the original products, and they are not affiliated with or endorsed by Microsoft, Anysphere (Cursor) or Movavi. Product names are trademarks of their owners and are used here only to describe what was studied. The reverse-engineering notes describe architecture observed in software installed on the author's own machine. The captured third-party files used during analysis are deliberately excluded from this repository.
