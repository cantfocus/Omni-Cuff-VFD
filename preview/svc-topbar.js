// Port of src/TopBarService.h/.cpp — 7 top-bar segments on grid 13 with frame-table animations.
(function (G) {
  'use strict';
  const NS = G.VFDSim = G.VFDSim || {};

  const kTopBarCount = 7;

  const Pattern = Object.freeze({
    OFF: 0,
    SPREAD: 1,            // PATTERN_1
    MARCHING_ANTS: 2,     // PATTERN_2
    DOUBLE_ANTS: 3,       // PATTERN_3
    TRIPLE_ANTS: 4,       // PATTERN_4
    DOUBLE_SPREAD: 5,     // PATTERN_5
    FILL_EMPTY: 6,        // PATTERN_6
    FILL_RAPID_EMPTY: 7,
    FILL_INV_EMPTY: 8,
    PONG_1X: 9,
    PONG_2X: 10,
    PONG_3X: 11,
    PONG_INV: 12,
    FILL_RETREAT: 13,
  });

  const kPattern1 = [0x08, 0x14, 0x22, 0x41, 0x00];
  const kPattern2 = [0x49, 0x12, 0x24];
  const kPattern3 = [0x33, 0x66, 0x4C, 0x19];
  const kPattern4 = [0x67, 0x4E, 0x1C, 0x39, 0x73];
  const kPattern5 = [0x08, 0x1C, 0x36, 0x63, 0x41, 0x00, 0x00];
  const kPattern6 = [
    0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x40, 0x41,
    0x42, 0x44, 0x48, 0x50, 0x60, 0x60, 0x61, 0x62, 0x64, 0x68,
    0x70, 0x70, 0x71, 0x72, 0x74, 0x78, 0x78, 0x79, 0x7A, 0x7C,
    0x7C, 0x7D, 0x7E, 0x7E, 0x7F, 0x7F, 0x7F, 0x7F, 0x7F, 0x7F, 0x7F, 0x3F, 0x3F, 0x5F,
    0x1F, 0x1F, 0x2F, 0x4F, 0x0F, 0x0F, 0x17, 0x27, 0x47, 0x07,
    0x07, 0x0B, 0x13, 0x23, 0x43, 0x03, 0x03, 0x05, 0x09, 0x11,
    0x21, 0x41, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x00, 0x00, 0x00, 0x00,
  ];
  const fill_rapid_empty = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x40, 0x41, 0x42, 0x44, 0x48, 0x50, 0x60, 0x60, 0x61, 0x62, 0x64, 0x68, 0x70, 0x70, 0x71, 0x72, 0x74, 0x78, 0x78, 0x79, 0x7A, 0x7C, 0x7C, 0x7D, 0x7E, 0x7E, 0x7F, 0x7F, 0x7F, 0x7F, 0x7F, 0x7E, 0x7C, 0x78, 0x70, 0x60, 0x40, 0x00, 0x00, 0x00, 0x00];
  const fill_inv_empty = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x40, 0x41, 0x42, 0x44, 0x48, 0x50, 0x60, 0x60, 0x61, 0x62, 0x64, 0x68, 0x70, 0x70, 0x71, 0x72, 0x74, 0x78, 0x78, 0x79, 0x7A, 0x7C, 0x7C, 0x7D, 0x7E, 0x7E, 0x7F, 0x7F, 0x7F, 0x7F, 0x7F, 0x3F, 0x1F, 0x2F, 0x37, 0x3B, 0x3D, 0x3E, 0x3F, 0x3F, 0x1F, 0x0F, 0x17, 0x1B, 0x1D, 0x1E, 0x1F, 0x1F, 0x0F, 0x07, 0x0B, 0x0D, 0x0D, 0x0E, 0x0F, 0x0F, 0x07, 0x03, 0x05, 0x06, 0x07, 0x07, 0x03, 0x01, 0x02, 0x03, 0x01, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00];
  const Pong_1x = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01];
  const Pong_2x = [0x03, 0x06, 0x0C, 0x18, 0x30, 0x60, 0x60, 0x30, 0x18, 0x0C, 0x06, 0x03];
  const Pong_3x = [0x07, 0x0E, 0x1C, 0x38, 0x70, 0x70, 0x38, 0x1C, 0x0E, 0x07];
  const Pong_inv = [0x7E, 0x7D, 0x7B, 0x77, 0x6F, 0x5F, 0x3F, 0x3F, 0x5F, 0x6F, 0x77, 0x7B, 0x7D, 0x7E];
  const Fill_Retreat = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x40, 0x41, 0x42, 0x44, 0x48, 0x50, 0x60, 0x60, 0x61, 0x62, 0x64, 0x68, 0x70, 0x70, 0x71, 0x72, 0x74, 0x78, 0x78, 0x79, 0x7A, 0x7C, 0x7C, 0x7D, 0x7E, 0x7E, 0x7F, 0x7F, 0x7F, 0x7F, 0x7F, 0x3F, 0x1F, 0x0F, 0x07, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00];

  // Index = pattern number; null = no frames (OFF / unknown).
  const kFramesByPattern = [
    null, kPattern1, kPattern2, kPattern3, kPattern4, kPattern5, kPattern6,
    fill_rapid_empty, fill_inv_empty, Pong_1x, Pong_2x, Pong_3x, Pong_inv, Fill_Retreat,
  ];

  // Returns the frame array (or null); frameCount is frames.length (0 when null).
  // C++ stores frameCount in a uint8_t; all tables are < 256 frames.
  function getPatternFrames(patternNumber) {
    const f = kFramesByPattern[patternNumber];
    return f || null;
  }
  function frameCountOf(frames) { return frames ? (frames.length & 0xff) : 0; }

  const not64 = (x) => BigInt.asUintN(64, ~x);
  const u8 = (v) => (v & 0xff);
  const u32 = (v) => (v >>> 0);

  function isValidTopBarNumber(n) { return n >= 1 && n <= kTopBarCount; }
  function toIndex(n) { return u8(n - 1); }
  function patternBitForTopBar(n) { return u8(n - 1); }

  class TopBarService {
    /** @param {VFDSim.VfdDriver} vfd */
    constructor(vfd) {
      this.vfd_ = vfd;
      this.topBarRefs_ = new Array(kTopBarCount);
      this.topBarMaskByIndex_ = new Array(kTopBarCount).fill(0n);
      this.init();
    }

    init() {
      this.topBarRefs_[0] = { grid: 13, bit: 8 };
      this.topBarRefs_[1] = { grid: 13, bit: 7 };
      this.topBarRefs_[2] = { grid: 13, bit: 6 };
      this.topBarRefs_[3] = { grid: 13, bit: 5 };
      this.topBarRefs_[4] = { grid: 13, bit: 4 };
      this.topBarRefs_[5] = { grid: 13, bit: 3 };
      this.topBarRefs_[6] = { grid: 13, bit: 2 };

      this.managedMaskGrid1_ = 0n;
      this.managedMaskGrid13_ = 0n;

      for (let i = 0; i < kTopBarCount; ++i) {
        const mask = 1n << BigInt(this.topBarRefs_[i].bit);
        this.topBarMaskByIndex_[i] = mask;
        if (this.topBarRefs_[i].grid === 1) this.managedMaskGrid1_ |= mask;
        else this.managedMaskGrid13_ |= mask;
      }

      this.manualMaskGrid1_ = 0n;
      this.manualMaskGrid13_ = 0n;
      this.animMaskGrid1_ = 0n;
      this.animMaskGrid13_ = 0n;

      this.patternNumber_ = 0;
      this.animationEnabled_ = false;
      this.animationReverse_ = false;
      this.animationMirror_ = false;
      this.lastFrame_ = 0;
      this.animationPeriodMs_ = 120;
      this.animationLastMs_ = 0;
      this.frameIndex_ = 0;

      this.apply();
    }

    setTopBarState(topBarNumber, enabled) {
      topBarNumber = u8(topBarNumber);
      if (!isValidTopBarNumber(topBarNumber)) return;

      const index = toIndex(topBarNumber);
      const mask = this.topBarMaskByIndex_[index];
      const grid = this.topBarRefs_[index].grid;

      if (grid === 1) {
        if (enabled) this.manualMaskGrid1_ |= mask;
        else this.manualMaskGrid1_ &= not64(mask);
      } else {
        if (enabled) this.manualMaskGrid13_ |= mask;
        else this.manualMaskGrid13_ &= not64(mask);
      }
    }

    /** @param {number} topBarNumber 1-based (1..7) */
    on(topBarNumber) {
      this.setTopBarState(topBarNumber, true);
      this.apply();
    }

    off(topBarNumber) {
      this.setTopBarState(topBarNumber, false);
      this.apply();
    }

    toggle(topBarNumber) {
      topBarNumber = u8(topBarNumber);
      if (!isValidTopBarNumber(topBarNumber)) return;
      this.setTopBarState(topBarNumber, !this.getState(topBarNumber));
      this.apply();
    }

    onAll() {
      for (let i = 1; i <= kTopBarCount; ++i) this.setTopBarState(i, true);
      this.apply();
    }

    offAll() {
      this.manualMaskGrid1_ = 0n;
      this.manualMaskGrid13_ = 0n;
      this.apply();
    }

    getState(topBarNumber) {
      topBarNumber = u8(topBarNumber);
      if (!isValidTopBarNumber(topBarNumber)) return false;
      const index = toIndex(topBarNumber);
      const mask = this.topBarMaskByIndex_[index];
      const grid = this.topBarRefs_[index].grid;
      return (grid === 1) ? ((this.manualMaskGrid1_ & mask) !== 0n)
                          : ((this.manualMaskGrid13_ & mask) !== 0n);
    }

    getCount() {
      let count = 0;
      let a = this.manualMaskGrid1_;
      let b = this.manualMaskGrid13_;
      while (a) { count += Number(a & 1n); a >>= 1n; }
      while (b) { count += Number(b & 1n); b >>= 1n; }
      return u8(count);
    }

    // C++ overloads setPattern(uint8_t) and setPattern(Pattern). Pattern enum values are the
    // same numbers, so one JS signature accepts either a raw pattern id or TopBarService.Pattern.X.
    setPattern(patternNumber) {
      this.patternNumber_ = u8(patternNumber);
      this.frameIndex_ = 0;

      const frameCount = frameCountOf(getPatternFrames(this.patternNumber_));
      if (frameCount > 0 && this.animationReverse_) {
        this.frameIndex_ = u8(frameCount - 1);
      }

      if (this.patternNumber_ === 0) {
        this.animMaskGrid1_ = 0n;
        this.animMaskGrid13_ = 0n;
        this.lastFrame_ = 0;
      } else {
        this.stepAnimationFrame();
      }

      this.apply();
    }

    getPattern() { return this.patternNumber_; }
    getPatternEnum() { return this.patternNumber_; }

    setAnimationEnabled(enabled) {
      this.animationEnabled_ = !!enabled;
      this.apply();
    }

    getAnimationEnabled() { return this.animationEnabled_; }

    setAnimationPeriod(periodMs) {
      periodMs = u32(periodMs);
      this.animationPeriodMs_ = (periodMs === 0) ? 1 : periodMs;
    }

    getAnimationPeriod() { return this.animationPeriodMs_; }

    setAnimationReverse(reverse) {
      this.animationReverse_ = !!reverse;
      const frameCount = frameCountOf(getPatternFrames(this.patternNumber_));
      if (frameCount > 0) {
        this.frameIndex_ = this.animationReverse_ ? u8(frameCount - 1) : 0;
      } else {
        this.frameIndex_ = 0;
      }
    }

    getAnimationReverse() { return this.animationReverse_; }

    // Flip the animated pattern left/right (segment 1 <-> 7).
    setAnimationMirror(mirror) {
      mirror = !!mirror;
      if (mirror === this.animationMirror_) return;
      this.animationMirror_ = mirror;
      if (this.patternNumber_ !== 0) {
        this.showFrame(this.lastFrame_);
        this.apply();
      }
    }

    getAnimationMirror() { return this.animationMirror_; }

    static flip7(frame7bit) {
      let out = 0;
      for (let i = 0; i < kTopBarCount; ++i) if (frame7bit & (1 << i)) out |= 1 << (kTopBarCount - 1 - i);
      return out;
    }

    showFrame(frame7bit) {
      this.lastFrame_ = frame7bit;
      const [g1, g13] = this.frameToMasks(this.animationMirror_ ? TopBarService.flip7(frame7bit) : frame7bit);
      this.animMaskGrid1_ = g1;
      this.animMaskGrid13_ = g13;
    }

    // C++ uses out-params; JS returns [grid1Mask, grid13Mask].
    frameToMasks(frame7bit) {
      let g1 = 0n, g13 = 0n;
      for (let topBar = 1; topBar <= kTopBarCount; ++topBar) {
        const bit = patternBitForTopBar(topBar);
        if ((frame7bit & (1 << bit)) === 0) continue;
        const index = toIndex(topBar);
        const grid = this.topBarRefs_[index].grid;
        const mask = this.topBarMaskByIndex_[index];
        if (grid === 1) g1 |= mask;
        else g13 |= mask;
      }
      return [g1, g13];
    }

    stepAnimationFrame() {
      const frames = getPatternFrames(this.patternNumber_);
      const frameCount = frameCountOf(frames);

      if (!frames || frameCount === 0) {
        this.animMaskGrid1_ = 0n;
        this.animMaskGrid13_ = 0n;
        return;
      }

      this.showFrame(frames[this.frameIndex_]);

      if (!this.animationReverse_) {
        this.frameIndex_ = u8((this.frameIndex_ + 1) % frameCount);
      } else {
        this.frameIndex_ = (this.frameIndex_ === 0) ? u8(frameCount - 1) : u8(this.frameIndex_ - 1);
      }
    }

    /** @param {number} now uint32 milliseconds */
    update(now) {
      now = u32(now);
      if (!this.animationEnabled_ || this.patternNumber_ === 0) return;
      if (u32(now - this.animationLastMs_) < this.animationPeriodMs_) return;

      this.animationLastMs_ = now;
      this.stepAnimationFrame();
      this.apply();
    }

    apply() {
      const finalGrid1 = this.manualMaskGrid1_ | (this.animationEnabled_ ? this.animMaskGrid1_ : 0n);
      const finalGrid13 = this.manualMaskGrid13_ | (this.animationEnabled_ ? this.animMaskGrid13_ : 0n);

      this.vfd_.andGridBits(1, not64(this.managedMaskGrid1_));
      this.vfd_.orGridBits(1, finalGrid1);

      this.vfd_.andGridBits(13, not64(this.managedMaskGrid13_));
      this.vfd_.orGridBits(13, finalGrid13);

      this.vfd_.buildFrames();
    }
  }

  TopBarService.kTopBarCount = kTopBarCount;
  TopBarService.Pattern = Pattern;

  NS.TopBarService = TopBarService;
})(typeof window !== 'undefined' ? window : globalThis);
