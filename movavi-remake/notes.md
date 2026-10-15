# Movavi Video Editor 26 — reverse-engineering notes

Target: `%APPDATA%\Movavi Video Editor 26` (471 MB, 402 files; per-user install). The MSIX package
`Movavi.videoeditorplus.package` is only a shell-integration stub (`wnshelper.exe`, external content).
Main exe `VideoEditor.exe`: PE32+ x64, 8.3 MB, sha256 15192b4a… (REA `inspect_pe_resources`, ev_83fc97fffa0ff09f551ac7eaa96e94cdba5722fdb8965ec3723374920e1e0b8a).

Method (no Ghidra on this machine): module inventory, Qt resource extraction (own RCC v3 parser → `target/rcc/`),
string/RTTI extraction from DLLs (`.?AV…@@` type descriptors give C++ class names without disassembly).
Legend: **[O]** observed · **[I]** inference · **[?]** unknown

## 1. Architecture [O module names / RTTI, I roles]
| Layer | Modules |
|---|---|
| UI | Qt 5 Widgets + QSS styling (`VideoEditor/style.qss`), some QML (QtQuick); `MQtUi`, `EditorView`, `EditorWidgets`, `EditorUiComponents`, `GraphicsFramework/Items` (timeline drawn with QGraphicsView) |
| App model | `EditorModel` — observer pattern: `Composition::IComposition` + `ICompositionObserver`/`CompositionWatcher`, `Collections::ICollection` (media library), `MarkerWatcher`, `BeatDetectionWatcher`, `CropAutoWatcher`, `ClipSyncWatcher`, `AIModel::Helper`; `EditorProject`/`EditorSerialization` (project files), `PubSub` messaging |
| Media core | FFmpeg 5 libs (`avcodec/avformat/avfilter/swscale/swresample`) wrapped by `FFWrapper`, `DecodersFF`, `EncodersFF`, `MuxerFF`, `ParserFF`, `FiltersFF`; plus `Demuxers`, `Multiplexer`, `ParserRAW` (camera RAW), `ParserHEIF`/`MuxerHEIF`, `ParserLUT`, `ParserCD` |
| HW acceleration | Decode: `DecoderNVDEC`, `DecoderDX`, `DecoderMF`; Encode: `EncoderNVENC`, `EncoderQSV` (`QSVWrapper`), `EncoderAMF` (`AMFManager`), `EncoderMF`, `EncoderDX`; `ComputingResourceManager`, `AccelerationTracker`, `CudaOGLInterop` |
| Render | OpenGL: `EffectsOgl` (81 effects, ~131 GLSL programs), `FiltersOgl`, `OglManager`, `RTVideoRendererOGLQt`/`VideoRendererDirectXQt`, `RTPlayerEngine` (real-time preview), `PlayerEngine` |
| Effects | `EffectsFF` (FFmpeg filters), `EffectsOnnxRT` (`HumanMatting` V1/V2 = AI background removal), `EffectsSpecial`, `EffectsMultiImpls`, `OverlayEngine`, `EditorPanAndZoom` (Ken Burns), `EditorAnimations` (keyframes), `LUTInt` |
| AI / analysis | `whisper` + `ggml` + `ctranslate2` (offline speech-to-text → subtitles, SRT export), `AnalyzerSpeechToText`, `AnalyzerSilenceDetector`, `AnalyzerFaceDetector`, `AnalyzerObjectDetector` (auto-crop), `BeatDetection`, `FiltersSpeex` (noise suppression), `TFLiteTools`, OpenCV, `DirectML`, `movavi_onnxruntime` |
| Capture | `VideoCapture.exe`, `CaptureDShow`, `CaptureAVCHD`, screen record |
| Content | `downloaderCache/*.mpack` (217 downloadable effect/sticker packs), `ResourceDownloadManager`, `MovaviWeb` (store) |
| Business | `AppActivation`, `PatentActivator`, `NagScreen`, `RegistrationDialog`, `MSparkle` (updates), Sentry/crashpad, trackers |

## 2. Feature inventory
**Transitions (51 classes, `Transition::*`)** [O]: AudioCrossfade, BarnDoor, Blinds, Blur, Circle, Cross, Crossfade, Cube, DirectCrossFade, Disintegrate, FadeInFadeOut, Flash, Glitch, KenBurns, Lens, MaskTransition, Matrix, Mosaic, MotionSpin, OrigamiFlips/Pleats/Valley, Overlay, Pageturn, Parallax, Pieces, Pinwheel, Pixels, Push, Puzzle, Radial, RageZoom, Ripple, RippleSmooth, Roll, Scale, ShaderISF, Shatter, Slice, Slide, SlidingDoor, Smear, Snake, Spin, Spiral, ThroughColor, Twist, Waterbrush, Whoosh, Wipe, Zoom.

**GPU effects (81 classes, `Movavi::Ogl::Effect*`)** [O]: 360Cylindrical, AddNoize, Aim, AlphaChannelModifier, AlphaEnvelope, AlphaInserter, AutoContrast, AutoWhiteBalance, BokehBlur, CameraShake, Censored, ChannelMixer, Chromakey, ChromaticAberration, ColorBalance, ColorBlender, ColorBrush, ColorCorrection, ColorCurves, ColorFilter, ColorMix{Burn,Exchange,Field}, ColorSelect, Crop, DenoiseNLM, Diffuse, DisplacementMap, Erosion, FillBlurredBackground, FilmStrip, FindEdges, FishEye, FixVertVideo, FlyingObjects, GIMP{BalanceChroma,ColorTemperature,Colorize,HueSaturation,ShadowsHightlights}, GaussianBlur, GlassMosaic, GlitchMpeg, GlitchSecurityCam, HalfTone, ISF, Invert, LUT, LensDistortion, LensFlare, LightLeaks, MagicEnhance, Mask, MaskedMix, Mirror, Mosaic, MotionBlur, MultiInputISF, NeonLamp, OilPaint, Opacity, PanAndZoom, PopArt, Posterize, RetroArtefacts, RetroColors, Saturation, Sharpen, ShiftLuma, ShiftUV, Stripes, SubFrame, Television70s, TemplateMES, TiltShift, Transform, Twirl, VHS, Vertigo, VignetteFilter, Zoom.
GLSL uniforms seen: `tex`, `tex_top`, `progress`, `intensity`, `opacity`, `lut` + `lutSize`, `blurTex`, `local_step`, `PassN` (multi-pass), `glareD`, `time`.

**Editing tools (UI icons in `rcc/`)** [O]: blade/split, crop + auto-crop, colour balance, rotate, record (voice/screen), silence removal, speech-to-text, transition wizard, add logo/ruler label; timeline: add video/audio/title tracks, link/unlink tracks, gapless (magnetic) mode toggle, markers (snap), beat markers, volume envelope keyframes, mute/hide track, reverse, mask, clone/copy/paste, export SRT.
**Export targets** [O]: video file, audio only, mobile devices, TV, online (YouTube) + advanced settings.

## 3. Open questions
- [?] Project file format (`EditorSerialization` uses boost::serialization [I])
- [?] Exact shader sources per effect (strings are embedded; mapping string→class needs a disassembler)

## 4. Rebuild
See `rebuild/README.md`. Built 2026-10-15: Electron + native FFmpeg engine (ffmpeg-static 6.1) + WebGL effects/transitions.
Verified: typecheck clean, `npm test` 16/16 engine checks (real FFmpeg, incl. Intel Quick Sync hardware encode), `npm run e2e` 15/15 in the Electron app.
