# 🎵 Audio Editor

A professional browser-based audio editor built with vanilla JavaScript und the Web Audio API. Record, edit, and export audio — entirely client-side for maximum privacy.

**Live Demo:** [audioeditor.wecanuseai.com](https://melbinjp.github.io/audio-editor/)

## ✨ Features

### Core
- **Import Audio** — drag & drop or file picker (MP3, WAV, OGG, M4A, FLAC)
- **Microphone Recording** — capture audio directly from your mic
- **Interactive Waveform** — zoom, pan, and click-to-seek
- **WAV Export** — download your edited audio

### Marker-Based Selection
- **Set Start / End markers** — click to place draggable green (start) and orange (end) marker lines
- **Drag to reposition** — grab marker handles to adjust precisely
- **Time label pills** — each marker shows its exact time (ms precision) on the waveform
- **Precise number inputs** — type exact start/end values in the bottom bar

### Editing & Effects
- Trim to selection
- Delete region
- Silence region
- Fade In / Fade Out
- Reverse
- Normalize
- Speed Up / Slow Down (relative to original, non-compounding)
- Undo / Redo (up to 20 steps)

### UI
- Dark DAW-inspired theme with glassmorphism
- Responsive layout
- Toast notifications
- Volume slider

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `Escape` | Stop |
| `I` | Set Start marker |
| `O` | Set End marker |
| `C` | Clear markers |
| `T` | Trim to selection |
| `Delete` | Delete selection |
| `R` | Toggle recording |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `Ctrl+A` | Select All |
| `Ctrl+O` | Import file |
| `+` / `-` | Zoom in / out |
| `0` | Fit to width |

## 🛠️ Tech Stack

- **Web Audio API** — decoding, playback, effects
- **Canvas API** — waveform & marker rendering
- **MediaRecorder API** — mic recording
- **Font Awesome 6** — icons
- **Google Fonts (Inter)** — typography

100% client-side — no server, no uploads, no tracking.

## 📂 Project Structure

```
├── index.html     # Single-page app shell
├── app.js         # AudioEngine + WaveformRenderer + UIController
├── css/
│   └── styles.css # Dark theme with glassmorphism
└── .github/
    └── workflows/
        └── static.yml  # GitHub Pages deployment
```

## 🚀 Deployment

Pushes to `main` automatically deploy to GitHub Pages via the included workflow.

## 📄 License

MIT License