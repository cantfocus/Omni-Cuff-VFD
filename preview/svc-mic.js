// MicService simulation: same public API as src/MicService.h.
//
// The firmware captures 16 kHz PDM audio, runs a 256-point FFT every ~16 ms and
// reduces it to 8 log-spaced bands scaled 0..9 with a per-band noise floor and
// shared auto-gain. In the browser there is no PDM peripheral, so band levels
// come from one of two sources:
//
//  - 'synthetic' (default): a beat-driven fake mix (kick / snare / hats / pads).
//  - 'browser': the real microphone via getUserMedia + Web Audio AnalyserNode,
//    enabled with `await mic.useBrowserMic()`. Any failure falls back silently
//    to 'synthetic'.
//
// Timing (warm-up, calibration, ~16 ms frame cadence) follows the firmware and
// is driven by the `now` passed to update(), i.e. simulated millis.
// Note: the synthetic source emits levels 0..9 directly (bypassing the
// auto-gain, which treats sustained synthetic energy as noise floor); only the
// browser-mic source goes through the computeLevels() port.
(function (G) {
  'use strict';
  const NS = G.VFDSim = G.VFDSim || {};

  const kBands = 8;
  const kMaxLevel = 9;
  const kFftSize = 256;
  const kSampleRate = 16000;
  const kFrameMs = (kFftSize * 1000) / kSampleRate; // 16 ms per FFT frame

  // Inclusive FFT bin ranges per band (bin width = 16000 / 256 = 62.5 Hz).
  const kBandLo = [1, 3, 5, 8, 16, 32, 64, 96];
  const kBandHi = [2, 4, 7, 15, 31, 63, 95, 111];
  const kBinHz = kSampleRate / kFftSize;

  // Auto-gain tuning (verbatim from src/MicService.cpp).
  const kMinSpanDb = 24.0;
  const kStartSpanDb = 40.0;
  const kFloorMarginDb = 6.0;
  const kFloorRiseDb = 0.05;
  const kFloorFallCoef = 0.1;
  const kPeakFallDb = 0.15;
  const kWarmupFrames = 6;
  const kCalFrames = 16;
  const kCalCoef = 0.3;

  const f32 = Math.fround;

  class MicService {
    constructor() {
      this.running_ = false;
      this.newFrame_ = false;
      this.pdmGain_ = 20;
      this.levels_ = new Array(kBands).fill(0);

      this.floorDb_ = new Array(kBands).fill(0);
      this.peakDb_ = 0;
      this.scaleInit_ = false;
      this.frameCount_ = 0;

      this.lastFrameMs_ = 0;
      this.haveFrameTime_ = false;

      // Source selection.
      this.source_ = 'synthetic';
      this.audio_ = null; // { ctx, stream, src, gain, analyser, bins: Float32Array }

      // Synthetic generator state.
      this.syn_ = {
        bpm: 118,
        seg: 0,           // current 8-bar segment index (changes arrangement)
        lastBeat: -1,
        lastSixteenth: -1,
        kick: 0, snare: 0, hat: 0,
        pad: new Array(kBands).fill(0),
        padTarget: new Array(kBands).fill(0),
        lead: 0, leadBand: 3,
        blip: new Array(kBands).fill(0),
      };
    }

    // ── Public API (src/MicService.h) ───────────────────────────

    /// @brief Precompute tables. Does not start capture.
    begin() {
      for (let b = 0; b < kBands; b++) this.levels_[b] = 0;
      this.scaleInit_ = false;
    }

    /// @brief Start capture. Always succeeds in the simulator.
    start() {
      if (this.running_) return true;
      this.running_ = true;
      this.scaleInit_ = false;
      this.frameCount_ = 0;
      this.haveFrameTime_ = false;
      if (this.audio_ && this.audio_.ctx.state === 'suspended') {
        this.audio_.ctx.resume().catch(() => {});
      }
      return true;
    }

    /// @brief Stop capture and zero the levels.
    stop() {
      if (!this.running_) return;
      this.running_ = false;
      for (let b = 0; b < kBands; b++) this.levels_[b] = 0;
      this.newFrame_ = true; // let consumers see the zeroed levels
    }

    isRunning() { return this.running_; }

    /// @brief Produce a frame if one is due (one per ~16 ms of `now`).
    update(now) {
      if (!this.running_) return;
      now = now >>> 0;
      if (!this.haveFrameTime_) {
        this.haveFrameTime_ = true;
        this.lastFrameMs_ = now;
        return;
      }
      const dt = (now - this.lastFrameMs_) >>> 0;
      if (dt < kFrameMs) return;
      // Like the hardware, frames that were missed while busy are dropped:
      // at most one frame is processed per update().
      this.lastFrameMs_ = dt > 10 * kFrameMs ? now : (this.lastFrameMs_ + kFrameMs) >>> 0;

      if (this.frameCount_ < kWarmupFrames) {
        this.frameCount_++;
        return;
      }

      if (this.source_ === 'browser' && this.audio_) {
        this._computeLevels(this._browserBandDb());
      } else {
        const lv = this._syntheticLevels(now);
        if (this.frameCount_ < kWarmupFrames + kCalFrames) {
          // Same blank calibration window as the firmware's computeLevels().
          this.frameCount_ = (this.frameCount_ + 1) & 0xffff;
          for (let b = 0; b < kBands; b++) this.levels_[b] = 0;
        } else {
          for (let b = 0; b < kBands; b++) this.levels_[b] = lv[b];
        }
      }
      this.newFrame_ = true;
    }

    /// @brief True once per processed frame; clears the flag.
    hasNewFrame() {
      const r = this.newFrame_;
      this.newFrame_ = false;
      return r;
    }

    /// @brief Band levels 0..9; index 0 = lowest frequency band.
    levels() { return this.levels_; }

    /// @brief PDM gain register value (0x00..0x50, 0x14 ~ 0 dB, 0.5 dB/step).
    setPdmGain(gain) {
      this.pdmGain_ = gain & 0xff;
      if (this.audio_) this.audio_.gain.gain.value = Math.pow(10, this._gainDb() / 20);
    }

    // ── Browser-only extras ──────────────────────────────────────

    /// @brief Use the real microphone. Resolves true on success; on any failure
    /// it silently stays on / falls back to the synthetic source and resolves false.
    async useBrowserMic() {
      if (this.audio_) { this.source_ = 'browser'; return true; }
      try {
        const md = G.navigator && G.navigator.mediaDevices;
        const AC = G.AudioContext || G.webkitAudioContext;
        if (!md || !md.getUserMedia || !AC) throw new Error('unsupported');
        const stream = await md.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        const ctx = new AC();
        if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) { /* ignore */ } }
        const src = ctx.createMediaStreamSource(stream);
        const gain = ctx.createGain();
        gain.gain.value = Math.pow(10, this._gainDb() / 20);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0; // firmware uses raw per-frame FFTs
        analyser.minDecibels = -140;
        analyser.maxDecibels = 0;
        src.connect(gain);
        gain.connect(analyser);
        const bins = new Float32Array(analyser.frequencyBinCount);
        // Map firmware band edges (Hz) onto this analyser's bins.
        const hzPerBin = ctx.sampleRate / analyser.fftSize;
        const ranges = [];
        for (let b = 0; b < kBands; b++) {
          const loHz = (kBandLo[b] - 0.5) * kBinHz;
          const hiHz = (kBandHi[b] + 0.5) * kBinHz;
          let lo = Math.max(1, Math.round(loHz / hzPerBin));
          let hi = Math.min(bins.length - 1, Math.round(hiHz / hzPerBin) - 1);
          if (hi < lo) hi = lo;
          ranges.push([lo, hi]);
        }
        this.audio_ = { ctx, stream, src, gain, analyser, bins, ranges };
        this.source_ = 'browser';
        this.scaleInit_ = false; // recalibrate floors for the new source
        this.frameCount_ = 0;
        return true;
      } catch (e) {
        this.source_ = 'synthetic';
        return false;
      }
    }

    /// @brief Switch back to the synthetic source (keeps the browser mic open).
    useSynthetic() {
      if (this.source_ !== 'synthetic') {
        this.source_ = 'synthetic';
        this.scaleInit_ = false;
        this.frameCount_ = 0;
      }
    }

    /// @brief Close the browser microphone stream and audio graph.
    releaseBrowserMic() {
      const a = this.audio_;
      this.audio_ = null;
      if (this.source_ === 'browser') this.useSynthetic();
      if (!a) return;
      try { a.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
      try { a.ctx.close(); } catch (e) { /* ignore */ }
    }

    /// @brief 'synthetic' or 'browser'.
    source() { return this.source_; }

    // ── Internals ────────────────────────────────────────────────

    _gainDb() { return (this.pdmGain_ - 20) * 0.5; }

    _browserBandDb() {
      const a = this.audio_;
      a.analyser.getFloatFrequencyData(a.bins);
      const out = new Array(kBands);
      for (let b = 0; b < kBands; b++) {
        const [lo, hi] = a.ranges[b];
        let power = 0;
        for (let k = lo; k <= hi; k++) {
          const v = a.bins[k];
          if (Number.isFinite(v)) power += Math.pow(10, v / 10);
        }
        out[b] = 10 * Math.log10(power + 1e-12);
      }
      return out;
    }

    // Beat-driven fake mix, returned directly as levels 0..9. The firmware's
    // auto-gain is designed for real audio (it treats any sustained energy as
    // noise floor), so the synthetic source bypasses it; only the warm-up /
    // calibration blank period is kept (see update()).
    _syntheticLevels(now) {
      const s = this.syn_;
      const beatMs = 60000 / s.bpm;
      const sixteenthMs = beatMs / 4;
      const beat = Math.floor(now / beatMs);
      const sixteenth = Math.floor(now / sixteenthMs);
      const seg = Math.floor(beat / 32);
      const dt = kFrameMs;

      if (seg !== s.seg) {
        s.seg = seg;
        s.bpm = 104 + Math.floor(Math.random() * 30);
      }
      const breakdown = (seg % 4) === 3; // every 4th segment: drums drop out

      if (beat !== s.lastBeat) {
        s.lastBeat = beat;
        const inBar = ((beat % 4) + 4) % 4;
        if (!breakdown || inBar === 0) s.kick = 1.0;
        if (!breakdown && (inBar === 1 || inBar === 3)) s.snare = 0.9;
        for (let b = 0; b < kBands; b++) {
          s.padTarget[b] = Math.random() < 0.35 ? Math.random() : s.padTarget[b];
        }
        if (Math.random() < 0.5) {
          s.leadBand = 2 + Math.floor(Math.random() * 4);
          s.lead = 0.6 + Math.random() * 0.4;
        }
      }
      if (sixteenth !== s.lastSixteenth) {
        s.lastSixteenth = sixteenth;
        if (!breakdown && (sixteenth % 2 === 1 || Math.random() < 0.3)) s.hat = 0.5 + Math.random() * 0.5;
        if (Math.random() < 0.25) s.lead = Math.max(s.lead, 0.4 + Math.random() * 0.5);
        if (Math.random() < 0.6) {
          const bb = Math.floor(Math.random() * kBands);
          s.blip[bb] = Math.max(s.blip[bb], 0.3 + Math.random() * 0.5);
        }
      }

      // Envelopes (per-frame exponential decay).
      s.kick *= Math.exp(-dt / 110);
      s.snare *= Math.exp(-dt / 90);
      s.hat *= Math.exp(-dt / 35);
      s.lead *= Math.exp(-dt / 260);
      for (let b = 0; b < kBands; b++) s.blip[b] *= Math.exp(-dt / 70);
      for (let b = 0; b < kBands; b++) s.pad[b] += (s.padTarget[b] - s.pad[b]) * 0.03;

      // PDM gain register: 0.5 dB/step around 0x14 (0 dB), applied as amplitude.
      const gain = Math.pow(10, this._gainDb() / 20);
      const out = new Array(kBands);
      for (let b = 0; b < kBands; b++) {
        let e = 0;
        e += s.kick * [1.0, 0.9, 0.45, 0.15, 0.05, 0.02, 0.01, 0.0][b];   // kick: lows
        e += s.snare * [0.05, 0.2, 0.45, 0.6, 0.55, 0.5, 0.45, 0.3][b];  // snare: body + noise
        e += s.hat * [0, 0, 0, 0.02, 0.08, 0.3, 0.7, 0.8][b];            // hats: highs
        const d = Math.abs(b - s.leadBand);
        e += s.lead * (d === 0 ? 0.8 : d === 1 ? 0.35 : 0);              // lead line
        e += s.pad[b] * 0.2;                                             // slow pad bed
        e += s.blip[b];                                                  // percussive texture
        e = e * gain + (Math.random() - 0.5) * 0.06;                     // a little jitter
        // Soft-knee compression so loud hits approach (but rarely pin) 9,
        // then the firmware's 6 dB-style gate: small energies read as 0.
        const c = 1 - Math.exp(-2.0 * Math.max(0, e));
        let lvl = Math.trunc(c * (kMaxLevel + 0.99) - 0.6);
        if (lvl < 0) lvl = 0;
        if (lvl > kMaxLevel) lvl = kMaxLevel;
        out[b] = lvl;
      }
      return out;
    }

    // Port of MicService::computeLevels() (float math via Math.fround).
    _computeLevels(dbIn) {
      const relDb = new Array(kBands);
      let maxRel = 0;

      for (let b = 0; b < kBands; b++) {
        const db = f32(dbIn[b]);
        if (!this.scaleInit_) this.floorDb_[b] = db;
        else if (this.frameCount_ < kWarmupFrames + kCalFrames) this.floorDb_[b] = f32(this.floorDb_[b] + (db - this.floorDb_[b]) * kCalCoef);
        else if (db < this.floorDb_[b]) this.floorDb_[b] = f32(this.floorDb_[b] + (db - this.floorDb_[b]) * kFloorFallCoef);
        else this.floorDb_[b] = f32(this.floorDb_[b] + kFloorRiseDb);

        relDb[b] = f32(db - this.floorDb_[b]);
        if (relDb[b] > maxRel) maxRel = relDb[b];
      }

      if (!this.scaleInit_) {
        this.peakDb_ = kStartSpanDb;
        this.scaleInit_ = true;
      }
      if (this.frameCount_ < kWarmupFrames + kCalFrames) {
        this.frameCount_ = (this.frameCount_ + 1) & 0xffff;
        for (let b = 0; b < kBands; b++) this.levels_[b] = 0;
        return;
      }
      if (maxRel > this.peakDb_) this.peakDb_ = maxRel;
      else this.peakDb_ = f32(this.peakDb_ - kPeakFallDb);
      if (this.peakDb_ < kMinSpanDb) this.peakDb_ = kMinSpanDb;

      const span = f32(this.peakDb_ - kFloorMarginDb);
      for (let b = 0; b < kBands; b++) {
        let ratio = f32((relDb[b] - kFloorMarginDb) / span);
        if (ratio < 0) ratio = 0;
        let lvl = Math.trunc(f32(ratio * f32(kMaxLevel + 0.99)));
        if (lvl > kMaxLevel) lvl = kMaxLevel;
        this.levels_[b] = lvl;
      }
    }
  }

  MicService.kBands = kBands;
  MicService.kMaxLevel = kMaxLevel;
  MicService.kFftSize = kFftSize;
  MicService.kSampleRate = kSampleRate;

  NS.MicService = MicService;
})(typeof window !== 'undefined' ? window : globalThis);
