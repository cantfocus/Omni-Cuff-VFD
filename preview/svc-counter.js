// Port of src/NumberCounterService.h/.cpp — odometer-style rolling digit counter.
// Fixed-point tick math, float32 conversions, per-digit roll timing and the
// row-by-row glyph scroll (with blank spacer rows) mirror the firmware exactly.
(function (G) {
  'use strict';
  const NS = G.VFDSim = G.VFDSim || {};

  const TEXT_LEN = 8;           // VfdDriver::kTextLen
  const TEXT_GRID_FIRST = 5;    // VfdDriver::kTextGridFirst
  const ANODE_BYTES = 5;        // VfdDriver::kAnodeBytes
  const UINT32_MAX = 0xffffffff;

  const u8 = (v) => (Number(v) & 0xff) >>> 0;
  const u32 = (v) => Number(v) >>> 0;
  const f32 = Math.fround;
  // size_t: negative values wrap to a huge index in C, so map them to MAX_SAFE_INTEGER.
  const sizeT = (v) => { const n = Math.floor(Number(v) || 0); return n < 0 ? Number.MAX_SAFE_INTEGER : n; };
  const charCode = (c) => (typeof c === 'number' ? c : (c ? c.charCodeAt(0) : 0)) & 0xff;

  // llroundf(): round half away from zero, then (uint32_t) cast of the long long.
  function llroundfToU32(x) {
    if (!Number.isFinite(x)) return 0; // UB in C; pick 0
    const r = x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5);
    return Number(BigInt.asUintN(32, BigInt(r)));
  }

  class NumberCounterService {
    /** @param {VfdDriver} vfd shared display driver */
    constructor(vfd) {
      this.vfd_ = vfd;

      // In-class member initialisers (header).
      this.running_ = false;
      this.increment_ = NumberCounterService.kDefaultIncrement;
      this.digits_ = NumberCounterService.kDefaultDigits;
      this.decimals_ = NumberCounterService.kDefaultDecimals;
      this.displayWidth_ = NumberCounterService.kDefaultDigits;
      this.stepIntervalMs_ = NumberCounterService.kDefaultStepIntervalMs;
      this.rollFrameMs_ = 60;
      this.scale_ = 1;
      this.modulus_ = 10;
      this.currentTicks_ = 0;
      this.anchorTicks_ = 0;
      this.anchorMs_ = 0;
      this.stepSizeTicks_ = 1;
      this.blankRowsBetweenDigits_ = NumberCounterService.kDefaultBlankRowsBetweenDigits;
      this.blankPadding_ = NumberCounterService.kDefaultBlankPadding;
      this.fontIndex_ = NumberCounterService.kDefaultFontIndex;

      this.digitAnimActive_ = new Array(TEXT_LEN).fill(false);
      this.digitAnimStartMs_ = new Array(TEXT_LEN).fill(0);
      this.digitAnimDurationMs_ = new Array(TEXT_LEN).fill(0);
      this.digitAnimFrom_ = new Array(TEXT_LEN).fill('\0');
      this.digitAnimTo_ = new Array(TEXT_LEN).fill('\0');

      this.displayText_ = ' '.repeat(TEXT_LEN);

      this.init();
    }

    init() {
      this.configure(NumberCounterService.kDefaultDigits, NumberCounterService.kDefaultDecimals,
                     NumberCounterService.kDefaultStepIntervalMs, NumberCounterService.kDefaultIncrement);
      this.currentTicks_ = 0;
      this.anchorTicks_ = 0;
      this.blankRowsBetweenDigits_ = NumberCounterService.kDefaultBlankRowsBetweenDigits;
      this.renderDisplayText(this.formatTicks(this.currentTicks_));
      this.running_ = false;
      this.blankPadding_ = NumberCounterService.kDefaultBlankPadding;
      this.fontIndex_ = NumberCounterService.kDefaultFontIndex;
      this.anchorMs_ = 0;
    }

    static pow10u(n) {
      let value = 1;
      for (let i = 0; i < n; ++i) value = Math.imul(value, 10) >>> 0;
      return value;
    }

    static clampDigits(digits, decimals) {
      if (digits === 0) digits = 1;
      let maxDigits = TEXT_LEN;
      if (decimals > 0 && maxDigits > 1) maxDigits = u8(maxDigits - 1 - decimals);
      if (maxDigits === 0) maxDigits = 1;
      if (digits > maxDigits) digits = maxDigits;
      return digits;
    }

    static isDigitChar(c) {
      const code = charCode(c);
      return code >= 0x30 && code <= 0x39;
    }

    configure(digits, decimals, stepIntervalMs, increment) {
      digits = u8(digits);
      decimals = u8(decimals);
      stepIntervalMs = u32(stepIntervalMs);
      if (decimals >= TEXT_LEN) decimals = TEXT_LEN - 1;

      this.digits_ = NumberCounterService.clampDigits(digits, decimals);
      this.decimals_ = decimals;
      this.displayWidth_ = u8(this.digits_ + ((this.decimals_ > 0) ? (1 + this.decimals_) : 0));

      this.scale_ = NumberCounterService.pow10u(this.decimals_);
      this.modulus_ = NumberCounterService.pow10u(u8(this.digits_ + this.decimals_));

      this.stepIntervalMs_ = (stepIntervalMs === 0) ? 1 : stepIntervalMs;
      this.rollFrameMs_ = Math.floor(this.stepIntervalMs_ / 3);
      if (this.rollFrameMs_ < 20) this.rollFrameMs_ = 20;

      this.increment_ = !!increment;
    }

    floatToTicks(value) {
      value = f32(Number(value));
      if (value < 0) value = 0;
      const scaled = f32(value * f32(this.scale_));
      let ticks = llroundfToU32(scaled);
      if (this.modulus_ > 0) ticks %= this.modulus_;
      return ticks;
    }

    ticksToFloat(ticks) {
      if (this.scale_ === 0) return 0;
      return f32(f32(ticks) / f32(this.scale_));
    }

    ticksAfterSteps(baseTicks, steps) {
      if (this.modulus_ === 0) return baseTicks;
      const delta = Number((BigInt(u32(steps)) * BigInt(this.stepSizeTicks_)) % BigInt(this.modulus_));
      if (this.increment_) return ((baseTicks + delta) >>> 0) % this.modulus_;
      return ((baseTicks + this.modulus_ - delta) >>> 0) % this.modulus_;
    }

    syncAnchorToNow(now) {
      now = u32(now);
      if (!this.running_) {
        this.anchorMs_ = now;
        this.anchorTicks_ = this.currentTicks_;
        return;
      }
      const elapsed = (now - this.anchorMs_) >>> 0;
      if (this.stepIntervalMs_ === 0) {
        this.anchorMs_ = now;
        this.anchorTicks_ = this.currentTicks_;
        return;
      }
      const wholeSteps = Math.floor(elapsed / this.stepIntervalMs_);
      this.anchorTicks_ = this.ticksAfterSteps(this.anchorTicks_, wholeSteps);
      this.currentTicks_ = this.anchorTicks_;
      this.anchorMs_ = (this.anchorMs_ + Math.imul(wholeSteps, this.stepIntervalMs_)) >>> 0;
    }

    /**
     * start(startValue, digits = 4, decimals = 0, stepIntervalMs = 200,
     *       increment = true, stepSize = 1.0, fontIndex = 0)
     */
    start(startValue,
          digits = NumberCounterService.kDefaultDigits,
          decimals = NumberCounterService.kDefaultDecimals,
          stepIntervalMs = NumberCounterService.kDefaultStepIntervalMs,
          increment = NumberCounterService.kDefaultIncrement,
          stepSize = NumberCounterService.kDefaultStepSize,
          fontIndex = NumberCounterService.kDefaultFontIndex) {
      this.configure(digits, decimals, stepIntervalMs, increment);
      this.fontIndex_ = sizeT(fontIndex);

      const t = this.floatToTicks(stepSize);
      this.stepSizeTicks_ = (t === 0) ? 1 : t;
      this.clearDigitAnimations();

      this.currentTicks_ = this.floatToTicks(startValue);
      this.anchorTicks_ = this.currentTicks_;
      this.renderDisplayText(this.formatTicks(this.currentTicks_));

      this.running_ = true;
      this.anchorMs_ = NS.millis();
    }

    stop() {
      this.running_ = false;
      this.clearDigitAnimations();
    }

    setDirection(increment) {
      this.syncAnchorToNow(NS.millis());
      this.increment_ = !!increment;
    }

    setStepSize(stepSize) {
      this.syncAnchorToNow(NS.millis());
      const t = this.floatToTicks(stepSize);
      this.stepSizeTicks_ = (t === 0) ? 1 : t;
    }

    getStepSize() { return this.ticksToFloat(this.stepSizeTicks_); }

    setStepInterval(stepIntervalMs) {
      this.syncAnchorToNow(NS.millis());
      stepIntervalMs = u32(stepIntervalMs);
      this.stepIntervalMs_ = (stepIntervalMs === 0) ? 1 : stepIntervalMs;
      this.rollFrameMs_ = Math.floor(this.stepIntervalMs_ / 3);
      if (this.rollFrameMs_ < 20) this.rollFrameMs_ = 20;
    }

    setRollFrameInterval(rollFrameMs) {
      rollFrameMs = u32(rollFrameMs);
      this.rollFrameMs_ = (rollFrameMs === 0) ? 1 : rollFrameMs;
    }

    setBlankRowsBetweenDigits(blankRows) {
      this.blankRowsBetweenDigits_ = u8(blankRows);
      this.clearDigitAnimations();
    }

    setBlankPadding(blankPadding) { this.blankPadding_ = u8(blankPadding); }

    setFontIndex(fontIndex) {
      this.fontIndex_ = sizeT(fontIndex);
      this.clearDigitAnimations();
    }

    getBlankRowsBetweenDigits() { return this.blankRowsBetweenDigits_; }
    getBlankPadding() { return this.blankPadding_; }
    getFontIndex() { return this.fontIndex_; }
    isRunning() { return this.running_; }
    isIncrementing() { return this.increment_; }
    getStepInterval() { return this.stepIntervalMs_; }
    getRollFrameInterval() { return this.rollFrameMs_; }
    getValue() { return this.ticksToFloat(this.currentTicks_); }
    getCurrentValue() { return this.getValue(); }
    getCurrentTicks() { return this.currentTicks_; }
    getDisplayText() { return this.displayText_; }

    // C: formatTicks(ticks, out) fills an 8-char buffer. JS: returns the 8-char string.
    formatTicks(ticks) {
      ticks = u32(ticks);
      let buf;
      if (this.decimals_ === 0) {
        // "%0*lu"
        buf = String(ticks).padStart(this.digits_, '0');
      } else {
        // "%0*lu.%0*lu"
        const intPart = Math.floor(ticks / this.scale_);
        const fracPart = ticks % this.scale_;
        buf = String(intPart).padStart(this.digits_, '0') + '.' +
              String(fracPart).padStart(this.decimals_, '0');
      }
      if (buf.length > 23) buf = buf.slice(0, 23); // snprintf into char[24]

      const len = buf.length;
      const width = this.displayWidth_;
      const pad = (width > len) ? (width - len) : 0;
      const leadingPad = this.blankPadding_;

      const out = new Array(TEXT_LEN).fill(' ');
      for (let i = 0; i < width && i < TEXT_LEN; ++i) {
        const dst = i + leadingPad;
        if (dst >= TEXT_LEN) break;
        const src = (i >= pad) ? (i - pad) : Infinity;
        if (src < len) out[dst] = buf[src];
      }
      return out.join('');
    }

    renderDisplayText(text) {
      NS.Fonts.setActive(this.fontIndex_);
      this.displayText_ = text;
      this.vfd_.setText(this.displayText_);
      this.vfd_.buildFrames();
    }

    // C: glyphRowsFromChar(c, rows[7]). JS: returns an array of 7 row bytes (bit col = col).
    static glyphRowsFromChar(c) {
      const rows = [0, 0, 0, 0, 0, 0, 0];
      let raw = NS.Fonts.glyphRaw(charCode(c));
      if (!raw) {
        raw = NS.Fonts.glyphRaw(0x20);
        if (!raw) return rows;
      }
      for (let row = 0; row < 7; ++row) {
        let rowBits = 0;
        for (let col = 0; col < 5; ++col) {
          if ((raw[col] >> row) & 0x01) rowBits |= (1 << col);
        }
        rows[row] = rowBits & 0xff;
      }
      return rows;
    }

    // C: packedGlyphFromRows(rows, packedOut). JS: returns Uint8Array(5).
    static packedGlyphFromRows(rows) {
      let bits = 0n;
      for (let row = 0; row < 7; ++row) {
        for (let col = 0; col < 5; ++col) {
          if ((rows[row] >> col) & 0x01) {
            bits |= (1n << BigInt(row * 5 + col));
          }
        }
      }
      const packedOut = new Uint8Array(ANODE_BYTES);
      packedOut[0] = Number(bits & 0xffn);
      packedOut[1] = Number((bits >> 8n) & 0xffn);
      packedOut[2] = Number((bits >> 16n) & 0xffn);
      packedOut[3] = Number((bits >> 24n) & 0xffn);
      packedOut[4] = Number((bits >> 32n) & 0x0fn);
      return packedOut;
    }

    clearDigitAnimations() {
      for (let i = 0; i < TEXT_LEN; ++i) {
        this.digitAnimActive_[i] = false;
        this.digitAnimStartMs_[i] = 0;
        this.digitAnimDurationMs_[i] = 0;
        this.digitAnimFrom_[i] = ' ';
        this.digitAnimTo_[i] = ' ';
      }
    }

    renderRollingFrame(fromText, toText, now, stepElapsedMs) {
      now = u32(now);
      stepElapsedMs = u32(stepElapsedMs);
      NS.Fonts.setActive(this.fontIndex_);
      const totalRows = u8(7 + this.blankRowsBetweenDigits_);
      const fullRollDurationMs = Math.imul(totalRows, this.rollFrameMs_) >>> 0;
      const stepStartMs = (now - stepElapsedMs) >>> 0;

      const baseText = fromText.split('');
      const animateMask = new Array(TEXT_LEN).fill(false);
      const rowStepPerDigit = new Array(TEXT_LEN).fill(0);
      const animFromText = new Array(TEXT_LEN).fill('\0');
      const animToText = new Array(TEXT_LEN).fill('\0');

      for (let i = 0; i < TEXT_LEN; ++i) {
        const src = fromText[i];
        const dst = toText[i];
        const bothDigits = NumberCounterService.isDigitChar(src) && NumberCounterService.isDigitChar(dst);

        if (this.digitAnimActive_[i]) {
          const animElapsedMs = (now - this.digitAnimStartMs_[i]) >>> 0;
          if (animElapsedMs >= this.digitAnimDurationMs_[i]) {
            this.digitAnimActive_[i] = false;
          } else {
            animateMask[i] = true;
            animFromText[i] = this.digitAnimFrom_[i];
            animToText[i] = this.digitAnimTo_[i];
            rowStepPerDigit[i] = u8(Math.floor(
              (Math.imul(animElapsedMs, totalRows) >>> 0) / this.digitAnimDurationMs_[i]));
            if (rowStepPerDigit[i] > totalRows) rowStepPerDigit[i] = totalRows;
            continue;
          }
        }

        if (src === dst || !bothDigits) {
          baseText[i] = dst;
          continue;
        }

        let digitPosFromRight = 0;
        for (let j = i + 1; j < TEXT_LEN; ++j) {
          if (NumberCounterService.isDigitChar(toText[j])) digitPosFromRight++;
        }

        let digitChangeIntervalMs = this.stepIntervalMs_;
        for (let p = 0; p < digitPosFromRight; ++p) {
          if (digitChangeIntervalMs > Math.floor(UINT32_MAX / 10)) {
            digitChangeIntervalMs = UINT32_MAX;
            break;
          }
          digitChangeIntervalMs *= 10;
        }

        if (fullRollDurationMs === 0) {
          baseText[i] = dst;
          continue;
        }

        if (digitChangeIntervalMs < Math.floor(fullRollDurationMs / 2)) {
          baseText[i] = dst;
          continue;
        }

        this.digitAnimActive_[i] = true;
        this.digitAnimStartMs_[i] = stepStartMs;
        this.digitAnimDurationMs_[i] = (digitChangeIntervalMs < fullRollDurationMs) ? digitChangeIntervalMs : fullRollDurationMs;
        this.digitAnimFrom_[i] = src;
        this.digitAnimTo_[i] = dst;
        animateMask[i] = true;
        animFromText[i] = src;
        animToText[i] = dst;
        rowStepPerDigit[i] = 0;
      }

      this.renderDisplayText(baseText.join(''));

      for (let i = 0; i < TEXT_LEN; ++i) {
        if (!animateMask[i]) continue;
        const srcRows = NumberCounterService.glyphRowsFromChar(animFromText[i]);
        const dstRows = NumberCounterService.glyphRowsFromChar(animToText[i]);
        const outRows = [0, 0, 0, 0, 0, 0, 0];

        const spacer = this.blankRowsBetweenDigits_;
        const rowStep = rowStepPerDigit[i];
        if (this.increment_) {
          // Outgoing glyph scrolls up, spacer rows, incoming glyph follows from below.
          for (let r = 0; r < 7; ++r) {
            const seqIndex = rowStep + r;
            if (seqIndex < 7) {
              outRows[r] = srcRows[seqIndex] | 0;
            } else if (seqIndex < (7 + spacer)) {
              outRows[r] = 0;
            } else {
              const dstIndex = seqIndex - (7 + spacer);
              outRows[r] = (dstIndex >= 0 && dstIndex < 7) ? dstRows[dstIndex] : 0;
            }
          }
        } else {
          // Decrementing: incoming glyph drops in from above.
          const offset = (7 + spacer) - rowStep;
          for (let r = 0; r < 7; ++r) {
            const seqIndex = offset + r;
            if (seqIndex < 7) {
              outRows[r] = dstRows[seqIndex] | 0;
            } else if (seqIndex < (7 + spacer)) {
              outRows[r] = 0;
            } else {
              const srcIndex = seqIndex - (7 + spacer);
              outRows[r] = (srcIndex >= 0 && srcIndex < 7) ? srcRows[srcIndex] : 0;
            }
          }
        }
        const grid = u8(TEXT_GRID_FIRST + i);
        const packed = NumberCounterService.packedGlyphFromRows(outRows);
        this.vfd_.setGridAnodes(grid, packed);
      }

      this.vfd_.buildFrames();
      this.displayText_ = toText;
    }

    update(now) {
      now = u32(now);
      if (!this.running_) return;
      if (this.stepIntervalMs_ === 0) return;

      const elapsed = (now - this.anchorMs_) >>> 0;
      const wholeSteps = Math.floor(elapsed / this.stepIntervalMs_);
      const stepElapsedMs = elapsed % this.stepIntervalMs_;

      const current = this.ticksAfterSteps(this.anchorTicks_, wholeSteps);
      this.currentTicks_ = current;

      const currentText = this.formatTicks(current);

      if (wholeSteps === 0) {
        this.renderDisplayText(currentText);
        return;
      }

      const previous = this.ticksAfterSteps(this.anchorTicks_, (wholeSteps - 1) >>> 0);
      const previousText = this.formatTicks(previous);

      this.renderRollingFrame(previousText, currentText, now, stepElapsedMs);
    }
  }

  NumberCounterService.kDefaultDigits = 4;
  NumberCounterService.kDefaultDecimals = 0;
  NumberCounterService.kDefaultStepIntervalMs = 200;
  NumberCounterService.kDefaultIncrement = true;
  NumberCounterService.kDefaultBlankRowsBetweenDigits = 1;
  NumberCounterService.kDefaultBlankPadding = 0;
  NumberCounterService.kDefaultFontIndex = 0;
  NumberCounterService.kDefaultStepSize = 1.0;
  NumberCounterService.kCachedBlankRowsBetweenDigits = 1;
  NumberCounterService.kTransitionRows = 7 + NumberCounterService.kCachedBlankRowsBetweenDigits;
  NumberCounterService.kTransitionFrameCount = NumberCounterService.kTransitionRows;

  NS.NumberCounterService = NumberCounterService;
})(typeof window !== 'undefined' ? window : globalThis);
