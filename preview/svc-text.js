// Port of src/TextService.h/.cpp — scrolling and flashing text on the 8 text grids.
// Timing and state machine mirror the firmware 1:1 so the preview matches the tube.
(function (G) {
  'use strict';
  const NS = G.VFDSim = G.VFDSim || {};

  const TEXT_LEN = 8;            // VfdDriver::kTextLen
  const MAX_TEXT_CHARS = 200;     // kMaxTextChars
  const MAX_FLASH_LINES = 12;    // kMaxFlashLines

  const u16 = (v) => (Number(v) & 0xffff) >>> 0;
  const u32 = (v) => Number(v) >>> 0;
  // size_t: negative values wrap to a huge count/index in C, so map them to MAX_SAFE_INTEGER.
  const sizeT = (v) => { const n = Math.floor(Number(v) || 0); return n < 0 ? Number.MAX_SAFE_INTEGER : n; };

  // C string semantics: stop at the first NUL, cap at maxLen chars.
  function cstr(s, maxLen) {
    if (s == null) return null;
    let str = String(s);
    const nul = str.indexOf('\0');
    if (nul >= 0) str = str.slice(0, nul);
    if (maxLen !== undefined && str.length > maxLen) str = str.slice(0, maxLen);
    return str;
  }

  class TextService {
    /** @param {VfdDriver} vfd shared display driver */
    constructor(vfd) {
      this.vfd_ = vfd;
      this.init();
    }

    init() { this.resetState(); }

    resetState() {
      this.text_ = '';
      this.flashLines_ = [];
      this.textLen_ = 0;
      this.leadPad_ = TEXT_LEN;
      this.trailPad_ = TEXT_LEN;
      this.running_ = false;
      this.mode_ = TextService.Mode.IDLE;
      this.targetScrollCount_ = TextService.kDefaultScrollCount;
      this.completedScrolls_ = 0;
      this.scrollSpeedMs_ = TextService.kDefaultScrollSpeedMs;
      this.direction_ = TextService.kDefaultDirection;
      this.fontIndex_ = TextService.kDefaultFontIndex;
      this.lastStepMs_ = 0;
      this.startIndex_ = 0;
      this.maxStartIndex_ = 0;
      this.bounceStep_ = 1;
      this.flashLineCount_ = 0;
      this.flashLineIndex_ = 0;
      this.flashRepeatsTarget_ = TextService.kDefaultFlashRepeats;
      this.flashRepeatsDone_ = 0;
      this.flashOnMs_ = TextService.kDefaultFlashOnMs;
      this.flashOffMs_ = TextService.kDefaultFlashOffMs;
      this.flashVisible_ = true;
      this.flashFontIndex_ = TextService.kDefaultFontIndex;
      this.pendingFirstTick_ = false;
    }

    // 32..255 survive (extended font glyphs included); control codes become ' '.
    static sanitizeChar(c) {
      const code = (typeof c === 'number' ? c : c.charCodeAt(0)) & 0xff;
      return (code >= 32) ? String.fromCharCode(code) : ' ';
    }

    /**
     * startScroll(text, scrollCount = 1, scrollSpeedMs = 120,
     *             direction = TextService.Direction.LEFT, fontIndex = 0,
     *             noLead = false, noTrail = false)
     */
    startScroll(text,
                scrollCount = TextService.kDefaultScrollCount,
                scrollSpeedMs = TextService.kDefaultScrollSpeedMs,
                direction = TextService.kDefaultDirection,
                fontIndex = TextService.kDefaultFontIndex,
                noLead = false,
                noTrail = false) {
      const src = cstr(text, MAX_TEXT_CHARS);
      if (src === null) {
        this.stop();
        return;
      }

      this.text_ = src;
      this.textLen_ = src.length;

      scrollCount = u16(scrollCount);
      scrollSpeedMs = u32(scrollSpeedMs);
      this.targetScrollCount_ = (scrollCount === 0) ? 1 : scrollCount;
      this.completedScrolls_ = 0;
      this.scrollSpeedMs_ = (scrollSpeedMs === 0) ? 1 : scrollSpeedMs;
      this.direction_ = direction;
      this.fontIndex_ = sizeT(fontIndex);
      this.lastStepMs_ = 0;
      this.pendingFirstTick_ = true;
      this.bounceStep_ = 1;
      this.leadPad_ = noLead ? 0 : TEXT_LEN;
      this.trailPad_ = noTrail ? 0 : TEXT_LEN;
      this.mode_ = TextService.Mode.SCROLL;

      if (NS.Fonts.setActive(this.fontIndex_)) {
        this.fontIndex_ = NS.Fonts.activeIndex();
      }

      this.computeWindowBounds();

      if (this.direction_ === TextService.Direction.RIGHT) {
        this.startIndex_ = this.maxStartIndex_;
      } else {
        this.startIndex_ = 0;
      }

      this.running_ = true;
      this.renderCurrentWindow();
    }

    /**
     * startFlashLines(lines, lineCount, repeats = 3, onMs = 250, offMs = 180, fontIndex = 0)
     * `lines` is an array of strings (C: const char* const*). `lineCount` may be
     * omitted/null, in which case lines.length is used. null entries flash blank.
     */
    startFlashLines(lines,
                    lineCount,
                    repeats = TextService.kDefaultFlashRepeats,
                    onMs = TextService.kDefaultFlashOnMs,
                    offMs = TextService.kDefaultFlashOffMs,
                    fontIndex = TextService.kDefaultFontIndex) {
      if (lines != null && lineCount == null) lineCount = lines.length;
      lineCount = sizeT(lineCount);
      if (!lines || lineCount === 0) {
        this.stop();
        return;
      }

      const cappedCount = (lineCount > MAX_FLASH_LINES) ? MAX_FLASH_LINES : lineCount;
      this.flashLines_ = [];

      for (let i = 0; i < cappedCount; ++i) {
        const src = cstr(lines[i]);
        if (src === null) {
          this.flashLines_[i] = '';
          continue;
        }
        let out = '';
        for (let j = 0; j < src.length && out.length < TEXT_LEN; ++j) {
          out += TextService.sanitizeChar(src[j]);
        }
        this.flashLines_[i] = out;
      }

      repeats = u16(repeats);
      onMs = u32(onMs);
      offMs = u32(offMs);
      this.flashLineCount_ = cappedCount;
      this.flashLineIndex_ = 0;
      this.flashRepeatsTarget_ = (repeats === 0) ? 1 : repeats;
      this.flashRepeatsDone_ = 0;
      this.flashOnMs_ = (onMs === 0) ? 1 : onMs;
      this.flashOffMs_ = (offMs === 0) ? 1 : offMs;
      this.flashVisible_ = true;
      this.flashFontIndex_ = sizeT(fontIndex);
      this.mode_ = TextService.Mode.FLASH;
      this.lastStepMs_ = 0;
      this.pendingFirstTick_ = true;

      if (NS.Fonts.setActive(this.flashFontIndex_)) {
        this.flashFontIndex_ = NS.Fonts.activeIndex();
      }

      this.running_ = true;
      this.renderFlashCurrentLine();
    }

    computeWindowBounds() {
      const totalVirtualLen = this.leadPad_ + this.textLen_ + this.trailPad_;
      const windowLen = TEXT_LEN;
      this.maxStartIndex_ = totalVirtualLen - windowLen;
      if (this.maxStartIndex_ < 0) {
        this.maxStartIndex_ = 0;
      }
    }

    charAtVirtualIndex(virtualIndex) {
      const textStart = this.leadPad_;
      const textEnd = textStart + this.textLen_;
      if (virtualIndex < textStart || virtualIndex >= textEnd) {
        return ' ';
      }
      return this.text_[virtualIndex - textStart];
    }

    renderCurrentWindow() {
      let window = '';
      for (let i = 0; i < TEXT_LEN; ++i) {
        window += this.charAtVirtualIndex(this.startIndex_ + i);
      }
      this.vfd_.setText(window);
      this.vfd_.buildFrames();
    }

    renderBlankWindow() {
      this.vfd_.setText(' '.repeat(TEXT_LEN));
      this.vfd_.buildFrames();
    }

    renderFlashCurrentLine() {
      if (this.flashLineCount_ === 0) {
        this.renderBlankWindow();
        return;
      }
      const safeIndex = (this.flashLineIndex_ < this.flashLineCount_) ? this.flashLineIndex_ : 0;
      this.vfd_.setText(this.flashLines_[safeIndex]);
      this.vfd_.buildFrames();
    }

    update(now) {
      now = u32(now);
      if (!this.running_) {
        return;
      }

      // First tick after start(): anchor the timer to 'now'.
      if (this.pendingFirstTick_) {
        this.pendingFirstTick_ = false;
        this.lastStepMs_ = now;
        return;
      }

      const D = TextService.Direction;

      if (this.mode_ === TextService.Mode.SCROLL) {
        if (((now - this.lastStepMs_) >>> 0) < this.scrollSpeedMs_) {
          return;
        }
        this.lastStepMs_ = now;

        switch (this.direction_) {
          case D.LEFT:
            if (this.startIndex_ < this.maxStartIndex_) {
              ++this.startIndex_;
            } else {
              this.completedScrolls_ = (this.completedScrolls_ + 1) & 0xffff;
              if (this.completedScrolls_ >= this.targetScrollCount_) {
                this.stop();
                return;
              }
              this.startIndex_ = 0;
            }
            break;

          case D.RIGHT:
            if (this.startIndex_ > 0) {
              --this.startIndex_;
            } else {
              this.completedScrolls_ = (this.completedScrolls_ + 1) & 0xffff;
              if (this.completedScrolls_ >= this.targetScrollCount_) {
                this.stop();
                return;
              }
              this.startIndex_ = this.maxStartIndex_;
            }
            break;

          case D.BOUNCE:
          default: {
            if (this.maxStartIndex_ === 0) {
              this.completedScrolls_ = (this.completedScrolls_ + 1) & 0xffff;
              if (this.completedScrolls_ >= this.targetScrollCount_) {
                this.stop();
                return;
              }
              break;
            }

            let next = this.startIndex_ + this.bounceStep_;
            if (next < 0 || next > this.maxStartIndex_) {
              this.bounceStep_ = -this.bounceStep_;
              next = this.startIndex_ + this.bounceStep_;
              this.completedScrolls_ = (this.completedScrolls_ + 1) & 0xffff;
              if (this.completedScrolls_ >= this.targetScrollCount_) {
                this.stop();
                return;
              }
            }
            this.startIndex_ = next;
            break;
          }
        }

        this.renderCurrentWindow();
        return;
      }

      if (this.mode_ === TextService.Mode.FLASH) {
        const waitMs = this.flashVisible_ ? this.flashOnMs_ : this.flashOffMs_;
        if (((now - this.lastStepMs_) >>> 0) < waitMs) {
          return;
        }
        this.lastStepMs_ = now;

        if (this.flashVisible_) {
          this.flashVisible_ = false;
          this.renderBlankWindow();
          return;
        }

        this.flashVisible_ = true;
        ++this.flashLineIndex_;
        if (this.flashLineIndex_ >= this.flashLineCount_) {
          this.flashLineIndex_ = 0;
          this.flashRepeatsDone_ = (this.flashRepeatsDone_ + 1) & 0xffff;
          if (this.flashRepeatsDone_ >= this.flashRepeatsTarget_) {
            this.stop();
            return;
          }
        }

        this.renderFlashCurrentLine();
      }
    }

    stop() {
      this.running_ = false;
      this.mode_ = TextService.Mode.IDLE;
    }

    isRunning() { return this.running_; }
    getMode() { return this.mode_; }
    getText() { return this.text_; }
    getScrollCount() { return this.targetScrollCount_; }
    getScrollSpeedMs() { return this.scrollSpeedMs_; }
    getDirection() { return this.direction_; }
    getFontIndex() { return this.fontIndex_; }

    static alertExampleLines() { return TextService._alertLines; }
  }

  TextService.Direction = Object.freeze({ LEFT: 0, RIGHT: 1, BOUNCE: 2 });
  TextService.Mode = Object.freeze({ IDLE: 0, SCROLL: 1, FLASH: 2 });

  TextService.kDefaultScrollCount = 1;
  TextService.kDefaultScrollSpeedMs = 120;
  TextService.kDefaultDirection = TextService.Direction.LEFT;
  TextService.kDefaultFontIndex = 0;
  TextService.kDefaultFlashRepeats = 3;
  TextService.kDefaultFlashOnMs = 250;
  TextService.kDefaultFlashOffMs = 180;
  TextService.kAlertExampleLineCount = 2;
  TextService._alertLines = Object.freeze(['URGENT', 'MESSAGE!']);

  NS.TextService = TextService;
})(typeof window !== 'undefined' ? window : globalThis);
