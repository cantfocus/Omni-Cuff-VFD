// Port of src/ClockService.{h,cpp}: "HH:MM:SS" across the 8 text cells with
// odometer-style rolling on every changed cell.
//
// Time source: firmware uses TimeKeeper (synced from the iPhone). The preview
// uses the browser's local time-of-day captured at reset, advanced by the
// simulated millis() clock, so playback speed and pause behave consistently.
(function (G) {
  'use strict';
  const NS = G.VFDSim = G.VFDSim || {};

  const TEXT_LEN = 8;
  const TEXT_GRID_FIRST = 5;
  const ICON_CLOCK = 'CLOCK_ICN';

  // Seconds-since-midnight of the wall clock at reset (preview "sync").
  NS.clockBaseSec = 0;
  NS.resetClockBase = () => {
    const d = new Date();
    NS.clockBaseSec = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  };
  NS.resetClockBase();

  NS.clockNow = () => {
    const sec = (NS.clockBaseSec + Math.floor(NS.millis() / 1000)) % 86400;
    return { h: Math.floor(sec / 3600), m: Math.floor(sec / 60) % 60, s: sec % 60 };
  };

  class ClockService {
    constructor(vfd, icons) {
      this.vfd_ = vfd;
      this.icons_ = icons;
      this.running_ = false;
      this.h24_ = true;
      this.iconOwned_ = false;
      this.rollFrameMs_ = ClockService.kDefaultRollFrameMs;
      this.fontIndex_ = ClockService.kDefaultFontIndex;
      this.blankRows_ = ClockService.kDefaultBlankRows;
      this.shown_ = ' '.repeat(TEXT_LEN);
      this.rollFrom_ = new Array(TEXT_LEN).fill(' ');
      this.rollStartMs_ = new Array(TEXT_LEN).fill(0);
      this.rolling_ = new Array(TEXT_LEN).fill(false);
      this.dirty_ = true;
    }

    iconIndex_() {
      const IS = NS.IconService;
      const n = (IS && IS.kIconCount) || 35;
      for (let i = 0; i < n; ++i) {
        const name = IS && IS.toCString ? IS.toCString(i) : '';
        if (name === ICON_CLOCK) return i;
      }
      return -1;
    }

    start(h24 = true, rollFrameMs = ClockService.kDefaultRollFrameMs, fontIndex = ClockService.kDefaultFontIndex,
          blankRows = ClockService.kDefaultBlankRows, showIcon = true) {
      this.h24_ = !!h24;
      this.rollFrameMs_ = rollFrameMs || 1;
      this.fontIndex_ = fontIndex;
      this.blankRows_ = Math.min(7, blankRows);
      this.rolling_.fill(false);
      this.shown_ = this.formatNow_();
      this.running_ = true;
      this.dirty_ = true;
      const icon = this.iconIndex_();
      if (showIcon && icon >= 0 && this.icons_ && !this.icons_.isOn(icon)) {
        this.icons_.on(icon);
        this.iconOwned_ = true;
      }
      this.render_(NS.millis());
    }

    stop() {
      if (!this.running_) return;
      this.running_ = false;
      if (this.iconOwned_) {
        const icon = this.iconIndex_();
        if (icon >= 0) this.icons_.off(icon);
        this.iconOwned_ = false;
      }
    }

    isRunning() { return this.running_; }

    formatNow_() {
      const t = NS.clockNow();
      let h = t.h;
      if (!this.h24_) { h %= 12; if (h === 0) h = 12; }
      const p2 = (n) => String(n).padStart(2, '0');
      const hh = (this.h24_ || h >= 10) ? p2(h) : ' ' + h;
      return `${hh}:${p2(t.m)}:${p2(t.s)}`.slice(0, TEXT_LEN);
    }

    update(now) {
      if (!this.running_) return;
      const target = this.formatNow_();
      const shown = this.shown_.split('');
      for (let i = 0; i < TEXT_LEN; ++i) {
        if (target[i] !== shown[i]) {
          this.rollFrom_[i] = shown[i];
          this.rollStartMs_[i] = now;
          this.rolling_[i] = true;
          shown[i] = target[i];
          this.dirty_ = true;
        }
      }
      this.shown_ = shown.join('');
      if (this.dirty_ || this.rolling_.some(Boolean)) this.render_(now);
    }

    render_(now) {
      const NC = NS.NumberCounterService;
      NS.Fonts.setActive(this.fontIndex_);
      this.vfd_.setText(this.shown_);
      const totalRows = 7 + this.blankRows_;
      const durationMs = totalRows * this.rollFrameMs_;
      for (let i = 0; i < TEXT_LEN; ++i) {
        if (!this.rolling_[i]) continue;
        const elapsed = (now - this.rollStartMs_[i]) >>> 0;
        if (elapsed >= durationMs) { this.rolling_[i] = false; continue; }
        const rowStep = Math.floor((elapsed * totalRows) / durationMs);
        const src = NC.glyphRowsFromChar(this.rollFrom_[i]);
        const dst = NC.glyphRowsFromChar(this.shown_[i]);
        const out = new Array(7);
        for (let r = 0; r < 7; ++r) {
          const seq = rowStep + r;
          if (seq < 7) out[r] = src[seq];
          else if (seq < totalRows) out[r] = 0;
          else out[r] = (seq - totalRows < 7) ? dst[seq - totalRows] : 0;
        }
        this.vfd_.setGridAnodes(TEXT_GRID_FIRST + i, NC.packedGlyphFromRows(out));
      }
      this.vfd_.buildFrames();
      this.dirty_ = false;
    }
  }

  ClockService.kDefaultRollFrameMs = 30;
  ClockService.kDefaultBlankRows = 1;
  ClockService.kDefaultFontIndex = 0;
  NS.ClockService = ClockService;
})(typeof window !== 'undefined' ? window : globalThis);
