# Movavi Remake

A desktop video editor with a native FFmpeg engine, rebuilt from scratch based on the reverse-engineering notes in `../notes.md`. No Movavi code or assets are used. The project began from our own Clipchamp Remake code and adds Movavi's native pipeline and tools.

## Run

```bash
npm install          # also downloads a static FFmpeg build (ffmpeg-static)
npm run build
npm start
```

## What's different from the browser remake (and why it mirrors Movavi)

| Feature | Implementation | Movavi module (observed) |
|---|---|---|
| Opens almost any format | FFmpeg probes every import; MKV/AVI/WMV/MPEG-4 Part 2 etc. get an H.264/AAC proxy automatically | `DecodersFF`, `ParserFF`, proxy/transcode |
| Hardware-accelerated export | Trial-encodes with NVENC / Quick Sync / AMF / Media Foundation and offers whatever works (this PC: `h264_qsv`, `h264_mf`) | `EncoderNVENC`, `EncoderQSV`, `EncoderAMF`, `EncoderMF`, `AccelerationTracker` |
| Export formats | MP4 (H.264/HEVC), MOV (ProRes), WebM (VP9), animated GIF, MP3; presets for YouTube, social and email | `EditorExport`, `MuxerFF`, export dialog categories |
| GPU effects | 16-effect chain per clip (ping-pong framebuffers): chroma key, 3D LUT (.cube), VHS, glitch, vignette, tilt-shift, film grain, old movie, chromatic aberration, sharpen, posterize, pop art, edges, mosaic, mirror, invert | `Movavi::Ogl::Effect*` (81 classes) |
| Transitions | 19 GLSL transitions in 4 groups + a "transition wizard" | `Transition::*` (51 classes) |
| Pan & Zoom | Eased Ken Burns between two focus points | `EditorPanAndZoom` |
| Silence removal | FFmpeg `silencedetect` → the clip is cut into its voiced pieces | `AnalyzerSilenceDetector` |
| Beat detection | Onset envelope + adaptive peak picking → timeline markers | `BeatDetection` |
| Magnetic timeline | Delete/move closes gaps (toggle) | gapless mode in `Timeline` |
| Markers & waveforms | M adds a marker; clips snap to markers; audio waveforms on clips | `MarkerWatcher`, envelope UI |

The architecture splits into three layers:
- `src/main/engine.ts` is the FFmpeg engine, testable in plain Node.
- `src/main/main.ts` is the Electron shell. One privileged `app://` scheme serves both the UI and the media (with byte ranges), so WebGL can read video frames.
- `src/renderer` holds the UI, the WebGL compositor and the timeline. Export streams raw RGBA frames from the compositor into FFmpeg's stdin.

## Tests

| Command | Proves |
|---|---|
| `npm test` | 16 engine checks with real FFmpeg: probe, proxy flagging and transcode, thumbnails, silence detection, waveform, beat detection, encoder detection, streaming export to MP4/WebM/MOV/GIF/MP3 with pixel and codec checks, and a real hardware encode |
| `npm run e2e` | 15 steps in the real Electron app: import (with AVI proxy), timeline, preview pixels, Invert and chroma key effects, Pan & Zoom, the barn-door transition at the cut, silence removal with the magnetic gap closing, beat markers, magnetic delete and undo, hardware-encoded MP4 export (verified with FFmpeg: codec, size, audio, duration, first-frame colour), GIF export, persistence across an app restart, and no renderer errors |

## Not built

Offline speech-to-text (Movavi uses whisper), AI background removal, screen capture, stabilization, the effect store, keyframe animation, and native timeline rendering.
