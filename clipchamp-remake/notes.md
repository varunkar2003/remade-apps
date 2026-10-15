# Clipchamp — reverse-engineering notes

Target: Clipchamp 4.7.10020.0 (MSIX, `C:\Program Files\WindowsApps\Clipchamp.Clipchamp_4.7.10020.0_x64__yxz26nhyzhsrt`)
plus the web editor's cached code from this PC's WebView2 profile (release 2026-06-22-01-rc00, commercial build).

Legend: **[O]** observed · **[I]** inference · **[?]** unknown

## 1. Architecture
| Layer | What | Evidence |
|---|---|---|
| Desktop shell | `Clipchamp.exe` (~36 MB, .NET + WebView2 + Windows App SDK + MSAL) — just hosts the web app | [O] package listing, `appsettings.json` |
| Web app | Consumer: `https://app.clipchamp.com`; work/school: SharePoint `/_layouts/15/videoeditorembed.aspx` | [O] `appsettings.json` |
| Static code | Create-React-App-style chunks on `res-sdp.public.cdn.office.net/clipchamp/<release>/commercial/static/js/*.chunk.js`; current live release id via `.../release/_1cdn_bucketedcontent/commercial/version.json` (was `2026-10-14-01-rc00`) | [O] cache + CDN |
| Media engine | `f_000024.js` (1.4 MB): WebCodecs `VideoEncoder`/`VideoDecoder`, WebGL (27 GLSL programs), OffscreenCanvas, Web Audio, OPFS (`navigator.storage.getDirectory`), IndexedDB | [O] API counts |
| FFmpeg WASM | 9 MB module: libavcodec, libavformat, libswscale, x264, OpenH264, dav1d (AV1), libvpx, fdk-aac, Matroska/WebM | [O] embedded strings |
| Demux | mp4box.js (`Mp4Box`) | [O] |
| Telemetry | Aria / 1DS (`browser.pipe.aria.microsoft.com`, `mobile.events.data.microsoft.com`) | [O] |

REA: `analyze_javascript_application` on f_000024/f_000023/f_000046 → 1,377 modules (ev_b1864609ac9db071fda27e563b051d82ea5dd1d9fc04a486c588a45ac1014f1d); f_000023 semantic graph truncated by budget.

Recovered bodies: `target/cache-bodies/` (62 files, decoded from Chromium blockfile `f_*` entries; br/gzip). Partial: only what this PC happened to load.

## 2. Pipeline [O pieces, I assembly]
1. **Import:** files are copied into OPFS (origin-private storage) and catalogued in IndexedDB, so projects survive reloads without uploading.
2. **Decode:** mp4box.js demuxes MP4 → WebCodecs `VideoDecoder`; FFmpeg WASM handles formats WebCodecs can't (MKV/WebM/AV1/legacy codecs) and remuxing.
3. **Composite:** WebGL on an OffscreenCanvas; per-item shaders (`u_image`, `u_strength`, `time`, blur `direction`, blend `s_base`/`s_blend`) for filters, effects and transitions.
4. **Audio:** Web Audio graph for preview; offline render for export.
5. **Export:** WebCodecs `VideoEncoder` (`avc: {format: "annexb"}`, `bitrateMode: "variable"`, optional hardware acceleration) → H.264 elementary stream → muxed to MP4 (FFmpeg WASM logs "framerate in output file").

## 3. Feature vocabulary [O]
- Transitions: crossFade, fadeThrough, crossBlur, hardWipe{Up,Down,Left,Right}, diagonalSoftWipe, diamond{Horizontal,Vertical}, push, reveal, pageTurn, cube, spin, zoom, blinds, exchange, horizontalBanding.
- Effects/filters: colour-filter, glitch, pixelate, bloom, burn, flicker, blur, zoomandpan / zoom_to_random (Ken Burns), mask, collage.
- Timeline item model: `trackId`, `itemId`, `startTime`, `endTime`, `trimStart`, `trimEnd`, `playbackRate`, `zIndex`.

## 4. Open questions
- [?] Full bundle set (CDN has no public manifest; only cached chunks were available)
- [?] Exact FFmpeg build flags / JS↔WASM interface (WABT not installed for REA's wasm inspector)

## 5. Rebuild
See `rebuild/README.md`. Built 2026-10-15: React + WebGL2 compositor + WebCodecs/mp4-muxer export, OPFS + IndexedDB.
Verified: `tsc` clean, `npm run e2e` 15/15 in headless Chrome (real pixels from preview and from the decoded exported MP4).
