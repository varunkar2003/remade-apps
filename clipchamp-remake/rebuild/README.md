# Clipchamp Remake

A browser video editor rebuilt from scratch, based on the reverse-engineering notes in `../notes.md`.
Like Clipchamp it runs entirely on your device: media goes into the Origin Private File System, projects into IndexedDB, and export happens with WebCodecs. Nothing is uploaded.

## Run

```bash
npm install
npm run dev        # http://localhost:5173  (or: npm run build && npm run preview)
```

It needs a Chromium browser (Chrome or Edge) for WebCodecs and OPFS.

## Features

| Area | What you can do | How it's built (Clipchamp equivalent) |
|---|---|---|
| Projects | Create, autosave, reopen and delete videos; change the aspect ratio (16:9, 9:16, 1:1, 4:5) and background | IndexedDB (same) |
| Media | Import video, audio and images by button or drag-and-drop; thumbnails, durations, audio detection | OPFS file storage (same) |
| Timeline | Multiple video/overlay and audio tracks; drag to move with snapping, move across tracks, trim handles, split (S), delete, duplicate (Ctrl+D), zoom/fit, mute/hide tracks, undo/redo | `trackId`/`startTime`/`trimStart`/`playbackRate` model (same vocabulary) |
| Preview | WebGL2 compositor at project resolution; drag a clip on the preview to reposition it | WebGL shader compositor |
| Transform | Scale, position, rotation, opacity, fit/fill | — |
| Colour | Brightness, contrast, saturation, hue, blur, black & white, sepia, plus 10 one-click looks | `colour-filter` effects |
| Transitions | Crossfade, fade through black, 4 wipes, 2 pushes, zoom, circle reveal, pixelate, with adjustable duration | `crossFade`, `fadeThrough`, `hardWipe*`, `push`, `zoom`… |
| Text | 5 title presets; edit content, font, size, colour, background box and alignment | Text overlays |
| Audio | Per-clip volume (to 200%), mute, fade in/out, speed 0.25×–4× | Web Audio |
| Export | 480p/720p/1080p MP4, H.264 + AAC (Opus fallback), with progress, cancel, preview and download | WebCodecs `VideoEncoder` → FFmpeg-WASM mux (we use mp4-muxer) |

**Keys:** Space play/pause · S split · Del delete · Ctrl+Z / Ctrl+Y undo/redo · Ctrl+D duplicate · ←/→ step a frame (Shift: 1 s) · Home/End

## Test

```bash
npm run build && npm run e2e
```

Headless Chrome generates its own fixtures: a 3 s WebM recorded from a canvas that turns red then green with a 440 Hz tone, and a PNG. It then imports them and checks real pixels from the WebGL preview. Covered: the frame colour, the black & white filter and its undo, the crossfade blend, text rendering (diffed against the hidden track), split/undo/redo, the trim handle, playback and the export. For the export, the test decodes the exported MP4 and verifies its size, duration, audio track, and red start and blue end frames. It also checks persistence of project and media across a reload, and that there are no page errors.

## Not built

The FFmpeg-WASM path (only formats the browser can decode are supported), stock media, recording, captions/AI features, keyframe animation, a green screen, and cloud backup.
