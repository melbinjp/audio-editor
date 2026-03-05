// ============================================================
// Audio Editor — app.js
// A complete browser-based audio editor.
// ============================================================

(() => {
    'use strict';

    // ────────────────────────────────────────────
    // Utility Helpers
    // ────────────────────────────────────────────
    function formatTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) return '0:00.0';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 10);
        return `${m}:${s.toString().padStart(2, '0')}.${ms}`;
    }

    function showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => {
            toast.classList.add('removing');
            toast.addEventListener('animationend', () => toast.remove());
        }, 3000);
    }

    // ────────────────────────────────────────────
    // AudioEngine — Web Audio API core
    // ────────────────────────────────────────────
    class AudioEngine {
        constructor() {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            this.buffer = null;
            this.originalBuffer = null;
            this.currentSpeed = 1.0;
            this.source = null;
            this.gainNode = this.ctx.createGain();
            this.gainNode.connect(this.ctx.destination);
            this.isPlaying = false;
            this.startedAt = 0;
            this.pauseOffset = 0;
            this.history = [];
            this.historyIndex = -1;
            this.maxHistory = 20;
            this.mediaRecorder = null;
            this.recordedChunks = [];
        }

        get duration() { return this.buffer ? this.buffer.duration : 0; }
        get sampleRate() { return this.buffer ? this.buffer.sampleRate : 0; }

        get currentTime() {
            if (!this.buffer) return 0;
            if (this.isPlaying) return this.pauseOffset + (this.ctx.currentTime - this.startedAt);
            return this.pauseOffset;
        }

        async loadFile(file) {
            if (this.ctx.state === 'suspended') await this.ctx.resume();
            const arrayBuffer = await file.arrayBuffer();
            this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
            this.originalBuffer = this._cloneBuffer(this.buffer);
            this.currentSpeed = 1.0;
            this.pauseOffset = 0;
            this.saveState();
            return this.buffer;
        }

        async loadArrayBuffer(arrayBuffer) {
            if (this.ctx.state === 'suspended') await this.ctx.resume();
            this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
            this.originalBuffer = this._cloneBuffer(this.buffer);
            this.currentSpeed = 1.0;
            this.pauseOffset = 0;
            this.saveState();
            return this.buffer;
        }

        play(fromTime) {
            if (!this.buffer) return;
            this._stopSource();
            if (this.ctx.state === 'suspended') this.ctx.resume();

            const playId = Symbol();
            this._currentPlayId = playId;

            this.source = this.ctx.createBufferSource();
            this.source.buffer = this.buffer;
            this.source.connect(this.gainNode);

            const offset = fromTime !== undefined ? fromTime : this.pauseOffset;
            this.pauseOffset = offset;
            this.startedAt = this.ctx.currentTime;
            this.source.start(0, offset);
            this.isPlaying = true;

            this.source.onended = () => {
                if (this._currentPlayId === playId && this.isPlaying) {
                    this.isPlaying = false;
                    this.pauseOffset = 0;
                    if (this.onPlaybackEnd) this.onPlaybackEnd();
                }
            };
        }

        pause() {
            if (!this.isPlaying) return;
            const elapsed = this.ctx.currentTime - this.startedAt;
            this.pauseOffset = this.pauseOffset + elapsed;
            if (this.pauseOffset > this.duration) this.pauseOffset = 0;
            this._stopSource();
        }

        stop() {
            this._stopSource();
            this.pauseOffset = 0;
        }

        _stopSource() {
            this.isPlaying = false;
            if (this.source) {
                try { this.source.stop(); } catch (_) { /* ok */ }
                this.source.disconnect();
                this.source = null;
            }
        }

        setVolume(value) { this.gainNode.gain.value = value; }

        // ──── Recording ────
        async startRecording() {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.recordedChunks = [];
            this.mediaRecorder = new MediaRecorder(stream);
            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) this.recordedChunks.push(e.data);
            };
            this.mediaRecorder.start();
        }

        async stopRecording() {
            return new Promise((resolve) => {
                this.mediaRecorder.onstop = async () => {
                    const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
                    const arrayBuffer = await blob.arrayBuffer();
                    this.mediaRecorder.stream.getTracks().forEach(t => t.stop());
                    this.mediaRecorder = null;
                    await this.loadArrayBuffer(arrayBuffer);
                    resolve(this.buffer);
                };
                this.mediaRecorder.stop();
            });
        }

        // ──── Editing ────
        _cloneBuffer(buf) {
            const clone = this.ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
            for (let ch = 0; ch < buf.numberOfChannels; ch++) {
                clone.copyToChannel(buf.getChannelData(ch).slice(), ch);
            }
            return clone;
        }

        saveState() {
            if (!this.buffer) return;
            this.history = this.history.slice(0, this.historyIndex + 1);
            this.history.push(this._cloneBuffer(this.buffer));
            if (this.history.length > this.maxHistory) this.history.shift();
            this.historyIndex = this.history.length - 1;
        }

        undo() {
            if (this.historyIndex <= 0) return false;
            this.stop();
            this.historyIndex--;
            this.buffer = this._cloneBuffer(this.history[this.historyIndex]);
            return true;
        }

        redo() {
            if (this.historyIndex >= this.history.length - 1) return false;
            this.stop();
            this.historyIndex++;
            this.buffer = this._cloneBuffer(this.history[this.historyIndex]);
            return true;
        }

        _regionToSamples(startSec, endSec) {
            const sr = this.buffer.sampleRate;
            return [Math.floor(startSec * sr), Math.floor(endSec * sr)];
        }

        trim(startSec, endSec) {
            if (!this.buffer) return;
            this.stop();
            const [s, e] = this._regionToSamples(startSec, endSec);
            const len = e - s;
            if (len <= 0) return;
            const nb = this.ctx.createBuffer(this.buffer.numberOfChannels, len, this.buffer.sampleRate);
            for (let ch = 0; ch < this.buffer.numberOfChannels; ch++) {
                nb.copyToChannel(this.buffer.getChannelData(ch).slice(s, e), ch);
            }
            this.buffer = nb;
            this.pauseOffset = 0;
            this.saveState();
        }

        deleteRegion(startSec, endSec) {
            if (!this.buffer) return;
            this.stop();
            const [s, e] = this._regionToSamples(startSec, endSec);
            const newLen = this.buffer.length - (e - s);
            if (newLen <= 0) return;
            const nb = this.ctx.createBuffer(this.buffer.numberOfChannels, newLen, this.buffer.sampleRate);
            for (let ch = 0; ch < this.buffer.numberOfChannels; ch++) {
                const orig = this.buffer.getChannelData(ch);
                const dest = nb.getChannelData(ch);
                dest.set(orig.subarray(0, s), 0);
                dest.set(orig.subarray(e), s);
            }
            this.buffer = nb;
            this.pauseOffset = Math.min(this.pauseOffset, this.buffer.duration);
            this.saveState();
        }

        silenceRegion(startSec, endSec) {
            if (!this.buffer) return;
            this.stop();
            const [s, e] = this._regionToSamples(startSec, endSec);
            const nb = this._cloneBuffer(this.buffer);
            for (let ch = 0; ch < nb.numberOfChannels; ch++) {
                const data = nb.getChannelData(ch);
                for (let i = s; i < e && i < data.length; i++) data[i] = 0;
            }
            this.buffer = nb;
            this.saveState();
        }

        fadeIn(startSec, endSec) {
            if (!this.buffer) return;
            this.stop();
            const [s, e] = this._regionToSamples(startSec, endSec);
            const len = e - s;
            if (len <= 0) return;
            const nb = this._cloneBuffer(this.buffer);
            for (let ch = 0; ch < nb.numberOfChannels; ch++) {
                const data = nb.getChannelData(ch);
                for (let i = s; i < e && i < data.length; i++) data[i] *= (i - s) / len;
            }
            this.buffer = nb;
            this.saveState();
        }

        fadeOut(startSec, endSec) {
            if (!this.buffer) return;
            this.stop();
            const [s, e] = this._regionToSamples(startSec, endSec);
            const len = e - s;
            if (len <= 0) return;
            const nb = this._cloneBuffer(this.buffer);
            for (let ch = 0; ch < nb.numberOfChannels; ch++) {
                const data = nb.getChannelData(ch);
                for (let i = s; i < e && i < data.length; i++) data[i] *= 1 - (i - s) / len;
            }
            this.buffer = nb;
            this.saveState();
        }

        reverse(startSec, endSec) {
            if (!this.buffer) return;
            this.stop();
            const [s, e] = this._regionToSamples(startSec, endSec);
            const nb = this._cloneBuffer(this.buffer);
            for (let ch = 0; ch < nb.numberOfChannels; ch++) {
                const data = nb.getChannelData(ch);
                const region = Array.from(data.subarray(s, e)).reverse();
                for (let i = 0; i < region.length; i++) data[s + i] = region[i];
            }
            this.buffer = nb;
            this.saveState();
        }

        normalize(startSec, endSec) {
            if (!this.buffer) return;
            this.stop();
            const [s, e] = this._regionToSamples(startSec, endSec);
            const nb = this._cloneBuffer(this.buffer);
            let max = 0;
            for (let ch = 0; ch < nb.numberOfChannels; ch++) {
                const data = nb.getChannelData(ch);
                for (let i = s; i < e && i < data.length; i++) max = Math.max(max, Math.abs(data[i]));
            }
            if (max === 0) return;
            const gain = 1.0 / max;
            for (let ch = 0; ch < nb.numberOfChannels; ch++) {
                const data = nb.getChannelData(ch);
                for (let i = s; i < e && i < data.length; i++) data[i] *= gain;
            }
            this.buffer = nb;
            this.saveState();
        }

        changeSpeed(targetRate) {
            if (!this.originalBuffer) return;
            this.stop();
            const src = this.originalBuffer;
            const newLen = Math.floor(src.length / targetRate);
            if (newLen <= 0) return;
            const nb = this.ctx.createBuffer(src.numberOfChannels, newLen, src.sampleRate);
            for (let ch = 0; ch < src.numberOfChannels; ch++) {
                const orig = src.getChannelData(ch);
                const dest = nb.getChannelData(ch);
                for (let i = 0; i < newLen; i++) {
                    const srcIdx = i * targetRate;
                    const idx0 = Math.floor(srcIdx);
                    const idx1 = Math.min(idx0 + 1, orig.length - 1);
                    const frac = srcIdx - idx0;
                    dest[i] = orig[idx0] * (1 - frac) + orig[idx1] * frac;
                }
            }
            this.buffer = nb;
            this.currentSpeed = targetRate;
            this.pauseOffset = 0;
            this.saveState();
        }

        // ──── Export ────
        exportWAV() {
            if (!this.buffer) return null;
            const buf = this.buffer;
            const numCh = buf.numberOfChannels;
            const sr = buf.sampleRate;
            const bitsPerSample = 16;
            const bytesPerSample = bitsPerSample / 8;
            const blockAlign = numCh * bytesPerSample;
            const dataLen = buf.length * blockAlign;
            const headerLen = 44;
            const ab = new ArrayBuffer(headerLen + dataLen);
            const v = new DataView(ab);

            const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)); };
            writeStr(0, 'RIFF');
            v.setUint32(4, 36 + dataLen, true);
            writeStr(8, 'WAVE');
            writeStr(12, 'fmt ');
            v.setUint32(16, 16, true);
            v.setUint16(20, 1, true);
            v.setUint16(22, numCh, true);
            v.setUint32(24, sr, true);
            v.setUint32(28, sr * blockAlign, true);
            v.setUint16(32, blockAlign, true);
            v.setUint16(34, bitsPerSample, true);
            writeStr(36, 'data');
            v.setUint32(40, dataLen, true);

            let off = headerLen;
            for (let i = 0; i < buf.length; i++) {
                for (let ch = 0; ch < numCh; ch++) {
                    let sample = buf.getChannelData(ch)[i];
                    sample = Math.max(-1, Math.min(1, sample));
                    v.setInt16(off, sample * 0x7FFF, true);
                    off += 2;
                }
            }
            return new Blob([ab], { type: 'audio/wav' });
        }
    }

    // ────────────────────────────────────────────
    // WaveformRenderer — Canvas visualization
    // ────────────────────────────────────────────
    class WaveformRenderer {
        constructor(canvas, rulerCanvas) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.rulerCanvas = rulerCanvas;
            this.rulerCtx = rulerCanvas.getContext('2d');

            this.buffer = null;
            this.samplesPerPixel = 256;
            this.minSPP = 8;
            this.maxSPP = 4096;

            // Markers (in seconds, -1 = not placed)
            this.startMarker = -1;
            this.endMarker = -1;

            // Playhead
            this.playheadTime = 0;

            // Interaction
            this.draggingMarker = null; // 'start', 'end', or null
            this.isDragging = false;
            this.markerHitZone = 8;

            // Colors
            this.waveColor = '#a29bfe';
            this.selColor = 'rgba(108, 92, 231, 0.18)';
            this.startMarkerColor = '#00b894';
            this.endMarkerColor = '#e17055';
            this.playheadColor = '#00cec9';
            this.bgColor = '#0f0f1a';
            this.centerLineColor = 'rgba(255,255,255,0.06)';
            this.rulerBg = '#161625';
            this.rulerText = '#606078';
            this.rulerTick = '#404058';
        }

        setBuffer(buffer) {
            this.buffer = buffer;
            this.startMarker = -1;
            this.endMarker = -1;
            this.playheadTime = 0;
            this.fitToWidth();
        }

        fitToWidth() {
            if (!this.buffer) return;
            const container = this.canvas.parentElement;
            const w = container.clientWidth;
            this.samplesPerPixel = Math.max(this.minSPP, Math.ceil(this.buffer.length / w));
            this._resize();
            this.draw();
        }

        zoomIn() {
            this.samplesPerPixel = Math.max(this.minSPP, Math.floor(this.samplesPerPixel / 1.5));
            this._resize();
            this.draw();
        }

        zoomOut() {
            this.samplesPerPixel = Math.min(this.maxSPP, Math.ceil(this.samplesPerPixel * 1.5));
            this._resize();
            this.draw();
        }

        _resize() {
            if (!this.buffer) return;
            const container = this.canvas.parentElement;
            const h = container.clientHeight;
            const w = Math.max(container.clientWidth, Math.ceil(this.buffer.length / this.samplesPerPixel));
            const dpr = window.devicePixelRatio || 1;
            this.canvas.width = w * dpr;
            this.canvas.height = h * dpr;
            this.canvas.style.width = w + 'px';
            this.canvas.style.height = h + 'px';
            this.ctx.scale(dpr, dpr);
            this.logicalWidth = w;
            this.logicalHeight = h;

            const rh = 24;
            this.rulerCanvas.width = w * dpr;
            this.rulerCanvas.height = rh * dpr;
            this.rulerCanvas.style.width = w + 'px';
            this.rulerCanvas.style.height = rh + 'px';
            this.rulerCtx.scale(dpr, dpr);
            this.rulerWidth = w;
            this.rulerHeight = rh;
        }

        timeToX(timeSec) {
            if (!this.buffer) return 0;
            return (timeSec * this.buffer.sampleRate) / this.samplesPerPixel;
        }

        xToTime(x) {
            if (!this.buffer) return 0;
            return (x * this.samplesPerPixel) / this.buffer.sampleRate;
        }

        draw() {
            if (!this.buffer) return;
            const { ctx, logicalWidth: w, logicalHeight: h } = this;
            ctx.clearRect(0, 0, w, h);

            ctx.fillStyle = this.bgColor;
            ctx.fillRect(0, 0, w, h);

            ctx.strokeStyle = this.centerLineColor;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, h / 2);
            ctx.lineTo(w, h / 2);
            ctx.stroke();

            // Waveform
            const data = this.buffer.getChannelData(0);
            const mid = h / 2;
            ctx.fillStyle = this.waveColor;
            for (let x = 0; x < w; x++) {
                const si = x * this.samplesPerPixel;
                const ei = Math.min(si + this.samplesPerPixel, data.length);
                let mn = 0, mx = 0;
                for (let i = si; i < ei; i++) {
                    if (data[i] < mn) mn = data[i];
                    if (data[i] > mx) mx = data[i];
                }
                const top = mid + mn * mid;
                const bottom = mid + mx * mid;
                ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
            }

            // Selection region between markers
            if (this.startMarker >= 0 && this.endMarker >= 0) {
                const x1 = this.timeToX(Math.min(this.startMarker, this.endMarker));
                const x2 = this.timeToX(Math.max(this.startMarker, this.endMarker));
                ctx.fillStyle = this.selColor;
                ctx.fillRect(x1, 0, x2 - x1, h);
            }

            // Start marker
            if (this.startMarker >= 0) this._drawMarker(this.startMarker, this.startMarkerColor, 'S');
            // End marker
            if (this.endMarker >= 0) this._drawMarker(this.endMarker, this.endMarkerColor, 'E');

            // Playhead
            const px = this.timeToX(this.playheadTime);
            ctx.strokeStyle = this.playheadColor;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(px, 0);
            ctx.lineTo(px, h);
            ctx.stroke();

            this._drawRuler();
        }

        _drawMarker(timeSec, color, label) {
            const { ctx, logicalHeight: h } = this;
            const x = this.timeToX(timeSec);

            // Vertical line
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();

            // Triangle handle at top
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x - 7, 14);
            ctx.lineTo(x + 7, 14);
            ctx.closePath();
            ctx.fill();

            // Label in triangle
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 8px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(label, x, 11);

            // Time pill at bottom
            const timeStr = timeSec.toFixed(3) + 's';
            ctx.font = '10px Inter, sans-serif';
            ctx.textAlign = 'center';
            const tw = ctx.measureText(timeStr).width + 8;
            const pillH = 16;
            const pillY = h - pillH - 4;
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.9;
            const r = 3;
            ctx.beginPath();
            ctx.moveTo(x - tw / 2 + r, pillY);
            ctx.lineTo(x + tw / 2 - r, pillY);
            ctx.arcTo(x + tw / 2, pillY, x + tw / 2, pillY + r, r);
            ctx.lineTo(x + tw / 2, pillY + pillH - r);
            ctx.arcTo(x + tw / 2, pillY + pillH, x + tw / 2 - r, pillY + pillH, r);
            ctx.lineTo(x - tw / 2 + r, pillY + pillH);
            ctx.arcTo(x - tw / 2, pillY + pillH, x - tw / 2, pillY + pillH - r, r);
            ctx.lineTo(x - tw / 2, pillY + r);
            ctx.arcTo(x - tw / 2, pillY, x - tw / 2 + r, pillY, r);
            ctx.closePath();
            ctx.fill();
            ctx.globalAlpha = 1.0;
            ctx.fillStyle = '#fff';
            ctx.fillText(timeStr, x, pillY + 12);
        }

        _drawRuler() {
            const { rulerCtx: ctx, rulerWidth: w, rulerHeight: h } = this;
            ctx.clearRect(0, 0, w, h);
            ctx.fillStyle = this.rulerBg;
            ctx.fillRect(0, 0, w, h);
            if (!this.buffer) return;

            const pxPerSec = this.buffer.sampleRate / this.samplesPerPixel;
            let tickInterval = 0.1;
            const intervals = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
            for (const iv of intervals) {
                if (iv * pxPerSec >= 60) { tickInterval = iv; break; }
            }

            ctx.fillStyle = this.rulerText;
            ctx.font = '10px Inter, sans-serif';
            ctx.textAlign = 'left';
            ctx.strokeStyle = this.rulerTick;
            ctx.lineWidth = 1;

            for (let t = 0; t <= this.buffer.duration; t += tickInterval) {
                const x = this.timeToX(t);
                ctx.beginPath();
                ctx.moveTo(x, h - 8);
                ctx.lineTo(x, h);
                ctx.stroke();
                ctx.fillText(formatTime(t), x + 3, h - 10);
            }
        }

        hitTestMarker(x) {
            if (this.startMarker >= 0) {
                if (Math.abs(x - this.timeToX(this.startMarker)) <= this.markerHitZone) return 'start';
            }
            if (this.endMarker >= 0) {
                if (Math.abs(x - this.timeToX(this.endMarker)) <= this.markerHitZone) return 'end';
            }
            return null;
        }

        getSelection() {
            if (this.startMarker < 0 || this.endMarker < 0) return null;
            return {
                start: Math.min(this.startMarker, this.endMarker),
                end: Math.max(this.startMarker, this.endMarker)
            };
        }

        selectAll() {
            if (!this.buffer) return;
            this.startMarker = 0;
            this.endMarker = this.buffer.duration;
            this.draw();
        }

        clearMarkers() {
            this.startMarker = -1;
            this.endMarker = -1;
        }
    }

    // ────────────────────────────────────────────
    // UIController — Wires everything together
    // ────────────────────────────────────────────
    class UIController {
        constructor() {
            this.engine = new AudioEngine();
            this.renderer = new WaveformRenderer(
                document.getElementById('waveformCanvas'),
                document.getElementById('timeRuler')
            );
            this.isRecording = false;
            this.animFrameId = null;
            this.markerMode = null; // 'start', 'end', or null

            this._cacheElements();
            this._bindEvents();
            this._bindShortcuts();
        }

        _cacheElements() {
            this.el = {
                fileInput: document.getElementById('fileInput'),
                dropZone: document.getElementById('dropZone'),
                waveformScroll: document.getElementById('waveformScroll'),
                fileName: document.getElementById('fileName'),
                fileDuration: document.getElementById('fileDuration'),
                fileSampleRate: document.getElementById('fileSampleRate'),
                preciseStart: document.getElementById('preciseStart'),
                preciseEnd: document.getElementById('preciseEnd'),
                selDuration: document.getElementById('selectionDuration'),
                volumeSlider: document.getElementById('volumeSlider'),
                volumeValue: document.getElementById('volumeValue'),
                // Buttons
                btnImport: document.getElementById('btnImport'),
                btnRecord: document.getElementById('btnRecord'),
                btnPlay: document.getElementById('btnPlay'),
                btnStop: document.getElementById('btnStop'),
                btnUndo: document.getElementById('btnUndo'),
                btnRedo: document.getElementById('btnRedo'),
                btnZoomIn: document.getElementById('btnZoomIn'),
                btnZoomOut: document.getElementById('btnZoomOut'),
                btnZoomFit: document.getElementById('btnZoomFit'),
                btnSetStart: document.getElementById('btnSetStart'),
                btnSetEnd: document.getElementById('btnSetEnd'),
                btnClearMarkers: document.getElementById('btnClearMarkers'),
                btnSelectAll: document.getElementById('btnSelectAll'),
                btnTrim: document.getElementById('btnTrim'),
                btnDelete: document.getElementById('btnDelete'),
                btnSilence: document.getElementById('btnSilence'),
                btnFadeIn: document.getElementById('btnFadeIn'),
                btnFadeOut: document.getElementById('btnFadeOut'),
                btnReverse: document.getElementById('btnReverse'),
                btnNormalize: document.getElementById('btnNormalize'),
                btnSpeedUp: document.getElementById('btnSpeedUp'),
                btnSlowDown: document.getElementById('btnSlowDown'),
                btnExport: document.getElementById('btnExport'),
            };
        }

        _bindEvents() {
            // Import
            this.el.btnImport.addEventListener('click', () => this.el.fileInput.click());
            this.el.fileInput.addEventListener('change', (e) => {
                if (e.target.files[0]) this._loadFile(e.target.files[0]);
            });

            // Drop zone
            this.el.dropZone.addEventListener('click', () => this.el.fileInput.click());
            this.el.dropZone.addEventListener('dragover', (e) => {
                e.preventDefault();
                this.el.dropZone.classList.add('dragover');
            });
            this.el.dropZone.addEventListener('dragleave', () => {
                this.el.dropZone.classList.remove('dragover');
            });
            this.el.dropZone.addEventListener('drop', (e) => {
                e.preventDefault();
                this.el.dropZone.classList.remove('dragover');
                if (e.dataTransfer.files[0]) this._loadFile(e.dataTransfer.files[0]);
            });

            // Record
            this.el.btnRecord.addEventListener('click', () => this._toggleRecord());

            // Playback
            this.el.btnPlay.addEventListener('click', () => this._togglePlay());
            this.el.btnStop.addEventListener('click', () => this._stop());

            // Undo/Redo
            this.el.btnUndo.addEventListener('click', () => this._undo());
            this.el.btnRedo.addEventListener('click', () => this._redo());

            // Zoom
            this.el.btnZoomIn.addEventListener('click', () => this.renderer.zoomIn());
            this.el.btnZoomOut.addEventListener('click', () => this.renderer.zoomOut());
            this.el.btnZoomFit.addEventListener('click', () => this.renderer.fitToWidth());

            // Marker buttons
            this.el.btnSetStart.addEventListener('click', () => this._enterMarkerMode('start'));
            this.el.btnSetEnd.addEventListener('click', () => this._enterMarkerMode('end'));
            this.el.btnClearMarkers.addEventListener('click', () => {
                this.renderer.clearMarkers();
                this.renderer.draw();
                this._updateSelectionInfo();
                showToast('Markers cleared', 'info');
            });

            // Select All
            this.el.btnSelectAll.addEventListener('click', () => {
                this.renderer.selectAll();
                this._updateSelectionInfo();
            });

            // Effects
            this.el.btnTrim.addEventListener('click', () => this._applyEffect('trim'));
            this.el.btnDelete.addEventListener('click', () => this._applyEffect('delete'));
            this.el.btnSilence.addEventListener('click', () => this._applyEffect('silence'));
            this.el.btnFadeIn.addEventListener('click', () => this._applyEffect('fadeIn'));
            this.el.btnFadeOut.addEventListener('click', () => this._applyEffect('fadeOut'));
            this.el.btnReverse.addEventListener('click', () => this._applyEffect('reverse'));
            this.el.btnNormalize.addEventListener('click', () => this._applyEffect('normalize'));
            this.el.btnSpeedUp.addEventListener('click', () => this._applyEffect('speedUp'));
            this.el.btnSlowDown.addEventListener('click', () => this._applyEffect('slowDown'));

            // Volume
            this.el.volumeSlider.addEventListener('input', (e) => {
                const v = parseInt(e.target.value);
                this.el.volumeValue.textContent = v + '%';
                this.engine.setVolume(v / 100);
            });

            // Export
            this.el.btnExport.addEventListener('click', () => this._export());

            // Precise time inputs — live update duration
            const onTimeInputChange = () => {
                const s = parseFloat(this.el.preciseStart.value) || 0;
                const e = parseFloat(this.el.preciseEnd.value) || 0;
                this.el.selDuration.textContent = Math.max(0, e - s).toFixed(3) + 's';
            };
            this.el.preciseStart.addEventListener('input', onTimeInputChange);
            this.el.preciseEnd.addEventListener('input', onTimeInputChange);

            // Apply typed values on Enter
            this.el.preciseStart.addEventListener('change', () => this._applyTypedMarkers());
            this.el.preciseEnd.addEventListener('change', () => this._applyTypedMarkers());

            // Waveform interaction
            const wfScroll = this.el.waveformScroll;
            wfScroll.addEventListener('mousedown', (e) => this._onWaveformMouseDown(e));
            window.addEventListener('mousemove', (e) => this._onWaveformMouseMove(e));
            window.addEventListener('mouseup', () => this._onWaveformMouseUp());

            // Resize
            window.addEventListener('resize', () => {
                if (this.engine.buffer) {
                    this.renderer._resize();
                    this.renderer.draw();
                }
            });

            // Playback end callback
            this.engine.onPlaybackEnd = () => this._updatePlayButton(false);
        }

        _bindShortcuts() {
            document.addEventListener('keydown', (e) => {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
                const ctrl = e.ctrlKey || e.metaKey;

                if (e.code === 'Space') { e.preventDefault(); this._togglePlay(); }
                else if (e.code === 'Escape') { this._exitMarkerMode(); this._stop(); }
                else if (e.code === 'KeyZ' && ctrl && !e.shiftKey) { e.preventDefault(); this._undo(); }
                else if ((e.code === 'KeyY' && ctrl) || (e.code === 'KeyZ' && ctrl && e.shiftKey)) { e.preventDefault(); this._redo(); }
                else if (e.code === 'KeyA' && ctrl) { e.preventDefault(); this.renderer.selectAll(); this._updateSelectionInfo(); }
                else if (e.code === 'Delete' || e.code === 'Backspace') { if (this.engine.buffer) { e.preventDefault(); this._applyEffect('delete'); } }
                else if (e.code === 'KeyT' && !ctrl) { this._applyEffect('trim'); }
                else if (e.code === 'KeyR' && !ctrl) { this._toggleRecord(); }
                else if (e.code === 'KeyO' && ctrl) { e.preventDefault(); this.el.fileInput.click(); }
                else if (e.code === 'KeyI' && !ctrl) { this._enterMarkerMode('start'); }
                else if (e.code === 'KeyO' && !ctrl) { this._enterMarkerMode('end'); }
                else if (e.code === 'KeyC' && !ctrl) {
                    this.renderer.clearMarkers();
                    this.renderer.draw();
                    this._updateSelectionInfo();
                }
                else if (e.code === 'Equal' || e.code === 'NumpadAdd') { this.renderer.zoomIn(); }
                else if (e.code === 'Minus' || e.code === 'NumpadSubtract') { this.renderer.zoomOut(); }
                else if (e.code === 'Digit0') { this.renderer.fitToWidth(); }
            });
        }

        // ──── Marker Mode ────
        _enterMarkerMode(which) {
            this.markerMode = which;
            // Visual feedback
            this.el.btnSetStart.classList.toggle('active', which === 'start');
            this.el.btnSetEnd.classList.toggle('active', which === 'end');
            this.el.waveformScroll.style.cursor = 'crosshair';
            showToast(`Click on waveform to set ${which} marker`, 'info');
        }

        _exitMarkerMode() {
            this.markerMode = null;
            this.el.btnSetStart.classList.remove('active');
            this.el.btnSetEnd.classList.remove('active');
            this.el.waveformScroll.style.cursor = 'default';
        }

        // ──── Waveform Interaction ────
        _onWaveformMouseDown(e) {
            if (!this.engine.buffer) return;
            const rect = this.renderer.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left + this.el.waveformScroll.scrollLeft;
            const time = Math.max(0, Math.min(this.renderer.xToTime(x), this.engine.duration));

            // If in marker mode, place the marker
            if (this.markerMode) {
                if (this.markerMode === 'start') {
                    this.renderer.startMarker = time;
                } else {
                    this.renderer.endMarker = time;
                }
                this.renderer.draw();
                this._updateSelectionInfo();
                this._exitMarkerMode();
                return;
            }

            // Check if clicking on an existing marker (to drag it)
            const hitMarker = this.renderer.hitTestMarker(x);
            if (hitMarker) {
                this.renderer.draggingMarker = hitMarker;
                this.renderer.isDragging = true;
                this.el.waveformScroll.style.cursor = 'ew-resize';
                return;
            }

            // Otherwise, click to seek
            this.renderer.playheadTime = time;
            this.engine.pauseOffset = time;
            this.renderer.draw();
        }

        _onWaveformMouseMove(e) {
            if (!this.renderer.isDragging || !this.renderer.draggingMarker) return;
            const rect = this.renderer.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left + this.el.waveformScroll.scrollLeft;
            const time = Math.max(0, Math.min(this.renderer.xToTime(x), this.engine.duration));

            if (this.renderer.draggingMarker === 'start') {
                this.renderer.startMarker = time;
            } else {
                this.renderer.endMarker = time;
            }
            this.renderer.draw();
            this._updateSelectionInfo();
        }

        _onWaveformMouseUp() {
            if (this.renderer.isDragging) {
                this.renderer.isDragging = false;
                this.renderer.draggingMarker = null;
                this.el.waveformScroll.style.cursor = 'default';
            }
        }

        // ──── Cursor feedback on hover ────
        _updateCursor(e) {
            if (!this.engine.buffer || this.markerMode) return;
            const rect = this.renderer.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left + this.el.waveformScroll.scrollLeft;
            const hit = this.renderer.hitTestMarker(x);
            this.el.waveformScroll.style.cursor = hit ? 'ew-resize' : 'default';
        }

        // ──── File Loading ────
        async _loadFile(file) {
            try {
                if (!file.type.startsWith('audio/')) {
                    showToast('Please select an audio file', 'error');
                    return;
                }
                if (file.size > 200 * 1024 * 1024) {
                    showToast('File too large (max 200MB)', 'error');
                    return;
                }
                showToast('Loading audio...', 'info');
                await this.engine.loadFile(file);
                this.renderer.setBuffer(this.engine.buffer);
                this._onAudioLoaded(file.name);
                showToast('Audio loaded successfully!', 'success');
            } catch (err) {
                console.error(err);
                showToast('Failed to load audio file: ' + err.message, 'error');
            }
        }

        _onAudioLoaded(name) {
            this.el.dropZone.classList.add('hidden');
            this.el.fileName.textContent = name || 'Recording';
            this.el.fileDuration.textContent = formatTime(this.engine.duration);
            this.el.fileSampleRate.textContent = this.engine.sampleRate + ' Hz';
            this.el.preciseEnd.max = this.engine.duration;
            this.el.preciseStart.max = this.engine.duration;
            this._enableButtons(true);
            this._updateSelectionInfo();
        }

        _enableButtons(enabled) {
            const btns = [
                'btnPlay', 'btnStop', 'btnUndo', 'btnRedo',
                'btnZoomIn', 'btnZoomOut', 'btnZoomFit',
                'btnSetStart', 'btnSetEnd', 'btnClearMarkers', 'btnSelectAll',
                'btnTrim', 'btnDelete', 'btnSilence',
                'btnFadeIn', 'btnFadeOut', 'btnReverse',
                'btnNormalize', 'btnSpeedUp', 'btnSlowDown', 'btnExport'
            ];
            btns.forEach(id => { this.el[id].disabled = !enabled; });
        }

        // ──── Record ────
        async _toggleRecord() {
            if (this.isRecording) {
                this.isRecording = false;
                this.el.btnRecord.classList.remove('recording');
                this.el.btnRecord.querySelector('i').className = 'fas fa-microphone';
                showToast('Processing recording...', 'info');
                try {
                    await this.engine.stopRecording();
                    this.renderer.setBuffer(this.engine.buffer);
                    this._onAudioLoaded('Recording');
                    showToast('Recording ready!', 'success');
                } catch (err) {
                    showToast('Recording failed: ' + err.message, 'error');
                }
            } else {
                try {
                    await this.engine.startRecording();
                    this.isRecording = true;
                    this.el.btnRecord.classList.add('recording');
                    this.el.btnRecord.querySelector('i').className = 'fas fa-circle';
                    showToast('Recording... Click again to stop', 'info');
                } catch (err) {
                    showToast('Microphone access denied', 'error');
                }
            }
        }

        // ──── Playback ────
        _togglePlay() {
            if (!this.engine.buffer) return;
            if (this.engine.isPlaying) {
                this.engine.pause();
                this._updatePlayButton(false);
                this._stopAnimationLoop();
            } else {
                const sel = this.renderer.getSelection();
                if (sel && this.engine.pauseOffset === 0) {
                    this.engine.play(sel.start);
                } else {
                    this.engine.play();
                }
                this._updatePlayButton(true);
                this._startAnimationLoop();
            }
        }

        _stop() {
            this.engine.stop();
            this._updatePlayButton(false);
            this._stopAnimationLoop();
            this.renderer.playheadTime = 0;
            this.renderer.draw();
        }

        _updatePlayButton(playing) {
            this.el.btnPlay.querySelector('i').className = playing ? 'fas fa-pause' : 'fas fa-play';
        }

        _startAnimationLoop() {
            const tick = () => {
                this.renderer.playheadTime = this.engine.currentTime;
                this.renderer.draw();
                const px = this.renderer.timeToX(this.engine.currentTime);
                const scroll = this.el.waveformScroll;
                if (px > scroll.scrollLeft + scroll.clientWidth - 50) {
                    scroll.scrollLeft = px - 100;
                }
                if (this.engine.isPlaying) this.animFrameId = requestAnimationFrame(tick);
            };
            this.animFrameId = requestAnimationFrame(tick);
        }

        _stopAnimationLoop() {
            if (this.animFrameId) {
                cancelAnimationFrame(this.animFrameId);
                this.animFrameId = null;
            }
        }

        // ──── Selection Info ────
        _updateSelectionInfo() {
            const sel = this.renderer.getSelection();
            if (sel) {
                this.el.preciseStart.value = sel.start.toFixed(3);
                this.el.preciseEnd.value = sel.end.toFixed(3);
                this.el.selDuration.textContent = (sel.end - sel.start).toFixed(3) + 's';
            } else {
                if (this.renderer.startMarker >= 0) {
                    this.el.preciseStart.value = this.renderer.startMarker.toFixed(3);
                }
                if (this.renderer.endMarker >= 0) {
                    this.el.preciseEnd.value = this.renderer.endMarker.toFixed(3);
                }
                this.el.selDuration.textContent = '0.000s';
            }
        }

        _applyTypedMarkers() {
            if (!this.engine.buffer) return;
            const s = parseFloat(this.el.preciseStart.value) || 0;
            const e = parseFloat(this.el.preciseEnd.value) || 0;
            this.renderer.startMarker = Math.max(0, Math.min(s, this.engine.duration));
            this.renderer.endMarker = Math.max(0, Math.min(e, this.engine.duration));
            this.renderer.draw();
            this._updateSelectionInfo();
        }

        // ──── Effects ────
        _applyEffect(effectName) {
            const sel = this.renderer.getSelection();
            let start, end;
            if (sel) {
                start = sel.start;
                end = sel.end;
            } else {
                start = 0;
                end = this.engine.duration;
            }

            try {
                switch (effectName) {
                    case 'trim':
                        if (!sel) { showToast('Place Start and End markers first', 'info'); return; }
                        this.engine.trim(start, end);
                        showToast('Trimmed!', 'success');
                        break;
                    case 'delete':
                        if (!sel) { showToast('Place Start and End markers first', 'info'); return; }
                        this.engine.deleteRegion(start, end);
                        showToast('Region deleted', 'success');
                        break;
                    case 'silence':
                        this.engine.silenceRegion(start, end);
                        showToast('Region silenced', 'success');
                        break;
                    case 'fadeIn':
                        this.engine.fadeIn(start, end);
                        showToast('Fade in applied', 'success');
                        break;
                    case 'fadeOut':
                        this.engine.fadeOut(start, end);
                        showToast('Fade out applied', 'success');
                        break;
                    case 'reverse':
                        this.engine.reverse(start, end);
                        showToast('Reversed!', 'success');
                        break;
                    case 'normalize':
                        this.engine.normalize(start, end);
                        showToast('Normalized!', 'success');
                        break;
                    case 'speedUp': {
                        const newSpeed = Math.min(this.engine.currentSpeed + 0.25, 4.0);
                        this.engine.changeSpeed(newSpeed);
                        showToast(`Speed: ${newSpeed}x (original)`, 'success');
                        break;
                    }
                    case 'slowDown': {
                        const newSpeed = Math.max(this.engine.currentSpeed - 0.25, 0.25);
                        this.engine.changeSpeed(newSpeed);
                        showToast(`Speed: ${newSpeed}x (original)`, 'success');
                        break;
                    }
                }
                // Refresh waveform
                this.renderer.setBuffer(this.engine.buffer);
                this.el.fileDuration.textContent = formatTime(this.engine.duration);
                this._updateSelectionInfo();
            } catch (err) {
                console.error(err);
                showToast('Effect failed: ' + err.message, 'error');
            }
        }

        // ──── Undo/Redo ────
        _undo() {
            if (this.engine.undo()) {
                this.renderer.setBuffer(this.engine.buffer);
                this.el.fileDuration.textContent = formatTime(this.engine.duration);
                showToast('Undo', 'info');
            }
        }

        _redo() {
            if (this.engine.redo()) {
                this.renderer.setBuffer(this.engine.buffer);
                this.el.fileDuration.textContent = formatTime(this.engine.duration);
                showToast('Redo', 'info');
            }
        }

        // ──── Export ────
        _export() {
            if (!this.engine.buffer) return;
            const blob = this.engine.exportWAV();
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = (this.el.fileName.textContent || 'audio').replace(/\.[^.]+$/, '') + '_edited.wav';
            a.click();
            URL.revokeObjectURL(url);
            showToast('WAV exported!', 'success');
        }
    }

    // ──── Initialize ────
    new UIController();
})();
