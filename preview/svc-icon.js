// Port of src/IconService.h/.cpp — named single-segment icons spread across grids 1, 2, 4 and 13.
//
// C++ overloads every method for (ICON icon) and (int iconIndex). Both are plain numbers in JS,
// so each method takes a single numeric argument (an IconService.ICON value or a raw index).
// Out-of-range / negative / non-integer values are rejected exactly like the C++ guards.
(function (G) {
  'use strict';
  const NS = G.VFDSim = G.VFDSim || {};

  const ICON = Object.freeze({
    EON: 0,
    AG: 1,
    G1DOT: 2,
    MONO: 3,
    STEREO_ICN: 4,
    RDS: 5,
    B_ICON: 6,
    C_ICON: 7,
    A_D_G: 8,
    E: 9,
    DDNR: 10,
    BBE: 11,
    REV_L: 12,
    REV_M: 13,
    REV_R: 14,
    REC_ICN: 15,
    L_SIDE: 16,
    R_SIDE: 17,
    B_SHARP: 18,
    B_BRACKET: 19,
    SHARP_BRACKET: 20,
    MIC_VF: 21,
    AUTO: 22,
    REC: 23,
    CLOCK_ICN: 24,
    SLEEP: 25,
    T_BASS: 26,
    DSP_SURROUND: 27,
    GRAPHIC_EQ: 28,
    RANDOM: 29,
    PRGM: 30,
    EDIT: 31,
    RPLY_ICN: 32,
    KHZ: 33,
    MHZ: 34,
    ICON_COUNT: 35,
  });

  const kIconCount = ICON.ICON_COUNT;

  const kIconDefs = [
    { grid: 1, bit: 0 },   // EON
    { grid: 1, bit: 1 },   // AG
    { grid: 1, bit: 2 },   // G1DOT
    { grid: 1, bit: 3 },   // MONO
    { grid: 1, bit: 4 },   // STEREO_ICN
    { grid: 1, bit: 5 },   // RDS
    { grid: 1, bit: 6 },   // B
    { grid: 1, bit: 7 },   // C
    { grid: 1, bit: 8 },   // A_D_G
    { grid: 1, bit: 9 },   // E
    { grid: 2, bit: 1 },   // DDNR
    { grid: 2, bit: 2 },   // BBE
    { grid: 2, bit: 5 },   // REV_L
    { grid: 2, bit: 6 },   // REV_M
    { grid: 2, bit: 7 },   // REV_R
    { grid: 2, bit: 9 },   // REC_ICN
    { grid: 2, bit: 10 },  // L_SIDE
    { grid: 2, bit: 11 },  // R_SIDE
    { grid: 2, bit: 13 },  // B_SHARP
    { grid: 2, bit: 14 },  // B_BRACKET
    { grid: 2, bit: 15 },  // SHARP_BRACKET
    { grid: 2, bit: 21 },  // MIC_VF
    { grid: 2, bit: 22 },  // AUTO
    { grid: 4, bit: 0 },   // REC
    { grid: 4, bit: 4 },   // CLOCK_ICN
    { grid: 4, bit: 8 },   // SLEEP
    { grid: 4, bit: 12 },  // T_BASS
    { grid: 13, bit: 0 },  // DSP_SURROUND
    { grid: 13, bit: 1 },  // GRAPHIC_EQ
    { grid: 13, bit: 9 },  // RANDOM
    { grid: 13, bit: 10 }, // PRGM
    { grid: 13, bit: 11 }, // EDIT
    { grid: 13, bit: 12 }, // RPLY_ICN
    { grid: 13, bit: 13 }, // KHZ
    { grid: 13, bit: 14 }, // MHZ
  ];

  const kIconNames = Object.freeze([
    'EON', 'AG', 'G1DOT', 'MONO', 'STEREO_ICN', 'RDS', 'B_ICON', 'C_ICON', 'A_D_G', 'E',
    'DDNR', 'BBE', 'REV_L', 'REV_M', 'REV_R', 'REC_ICN', 'L_SIDE', 'R_SIDE', 'B_SHARP',
    'B_BRACKET', 'SHARP_BRACKET', 'MIC_VF', 'AUTO', 'REC', 'CLOCK_ICN', 'SLEEP', 'T_BASS',
    'DSP_SURROUND', 'GRAPHIC_EQ', 'RANDOM', 'PRGM', 'EDIT', 'RPLY_ICN', 'KHZ', 'MHZ',
  ]);

  const kGridCount = 13; // VfdDriver::kGridCount
  const kTextLen = 8;    // VfdDriver::kTextLen

  const not64 = (x) => BigInt.asUintN(64, ~x);
  const u32 = (v) => (v >>> 0);

  // Covers both the ICON and int overloads: negative / non-integer / >= ICON_COUNT -> invalid.
  function isValidIconIndex(index) {
    return Number.isInteger(index) && index >= 0 && index < kIconCount;
  }

  class IconService {
    /** @param {VFDSim.VfdDriver} vfd */
    constructor(vfd) {
      this.vfd_ = vfd;
      // Like the C++ constructor: zeroed tables, init() must be called explicitly.
      this.iconGrid_ = new Array(kIconCount).fill(0);
      this.iconMask_ = new Array(kIconCount).fill(0n);
      this.stateMaskByGrid_ = new Array(kGridCount).fill(0n);
      this.allMaskByGrid_ = new Array(kGridCount).fill(0n);
      this.testLastStepMs_ = 0;
      this.testCurrentIcon_ = 0;
      this.testPreviousIcon_ = -1;
    }

    /** toCString(ICON|int) -> name, or "UNKNOWN_ICON". Static, as in C++. */
    static toCString(icon) {
      if (!isValidIconIndex(icon)) return 'UNKNOWN_ICON';
      return kIconNames[icon];
    }

    init() {
      this.iconGrid_.fill(0);
      this.iconMask_.fill(0n);
      this.stateMaskByGrid_.fill(0n);
      this.allMaskByGrid_.fill(0n);

      for (let i = 0; i < kIconCount; ++i) {
        const grid = kIconDefs[i].grid;
        const bit = kIconDefs[i].bit;
        if (grid < 1 || grid > kGridCount || bit > 35) continue;

        const mask = 1n << BigInt(bit);
        this.iconGrid_[i] = grid;
        this.iconMask_[i] = mask;
        this.allMaskByGrid_[grid - 1] |= mask;
      }
    }

    /** @param {number} icon IconService.ICON value or icon index */
    on(icon) {
      if (!isValidIconIndex(icon)) return;
      const grid = this.iconGrid_[icon];
      const mask = this.iconMask_[icon];
      if (grid === 0 || mask === 0n) return;

      const gridIndex = grid - 1;
      if ((this.stateMaskByGrid_[gridIndex] & mask) !== 0n) return;

      this.stateMaskByGrid_[gridIndex] |= mask;
      this.vfd_.orGridBits(grid, mask);
      this.vfd_.buildFrames();
    }

    off(icon) {
      if (!isValidIconIndex(icon)) return;
      const grid = this.iconGrid_[icon];
      const mask = this.iconMask_[icon];
      if (grid === 0 || mask === 0n) return;

      const gridIndex = grid - 1;
      if ((this.stateMaskByGrid_[gridIndex] & mask) === 0n) return;

      this.stateMaskByGrid_[gridIndex] &= not64(mask);
      this.vfd_.andGridBits(grid, not64(mask));
      this.vfd_.buildFrames();
    }

    toggle(icon) {
      if (!isValidIconIndex(icon)) return;
      const grid = this.iconGrid_[icon];
      const mask = this.iconMask_[icon];
      if (grid === 0 || mask === 0n) return;

      const gridIndex = grid - 1;
      if ((this.stateMaskByGrid_[gridIndex] & mask) !== 0n) this.off(icon);
      else this.on(icon);
    }

    clearAll() {
      let changed = false;
      for (let i = 0; i < kGridCount; ++i) {
        const mask = this.stateMaskByGrid_[i];
        if (mask === 0n) continue;
        this.vfd_.andGridBits(i + 1, not64(mask));
        this.stateMaskByGrid_[i] = 0n;
        changed = true;
      }
      if (changed) this.vfd_.buildFrames();
    }

    setAll() {
      let changed = false;
      for (let i = 0; i < kGridCount; ++i) {
        const allMask = this.allMaskByGrid_[i];
        if (allMask === 0n) continue;
        const missing = allMask & not64(this.stateMaskByGrid_[i]);
        if (missing === 0n) continue;
        this.vfd_.orGridBits(i + 1, missing);
        this.stateMaskByGrid_[i] |= missing;
        changed = true;
      }
      if (changed) this.vfd_.buildFrames();
    }

    isOn(icon) {
      if (!isValidIconIndex(icon)) return false;
      const grid = this.iconGrid_[icon];
      const mask = this.iconMask_[icon];
      if (grid === 0 || mask === 0n) return false;
      return (this.stateMaskByGrid_[grid - 1] & mask) !== 0n;
    }

    /** @returns {number} grid 1..13, or -1 */
    getGridNumber(icon) {
      if (!isValidIconIndex(icon)) return -1;
      const grid = this.iconGrid_[icon];
      return (grid === 0) ? -1 : grid;
    }

    /** @returns {number} 1-based anode number (bit + 1), or -1 */
    getAnodeNumber(icon) {
      if (!isValidIconIndex(icon)) return -1;
      const mask = this.iconMask_[icon];
      if (mask === 0n) return -1;
      for (let bit = 0; bit < 36; ++bit) {
        if ((mask & (1n << BigInt(bit))) !== 0n) return bit + 1;
      }
      return -1;
    }

    /** Debug helper that steps through icons at a fixed cadence (writes "%02d%-6.6s" to the text grids). */
    runNameTestStep(now, stepMs = 500) {
      now = u32(now);
      stepMs = u32(stepMs);
      if (stepMs === 0) stepMs = 1;
      if (u32(now - this.testLastStepMs_) < stepMs) return;
      this.testLastStepMs_ = now;

      if (this.testPreviousIcon_ >= 0) this.off(this.testPreviousIcon_);
      this.on(this.testCurrentIcon_);

      const grid = this.getGridNumber(this.testCurrentIcon_);
      const name = IconService.toCString(this.testCurrentIcon_);

      // snprintf(text, kTextLen + 1, "%02d%-6.6s", grid < 0 ? 0 : grid, name)
      const g = grid < 0 ? 0 : grid;
      const text = (String(g).padStart(2, '0') + name.slice(0, 6).padEnd(6, ' ')).slice(0, kTextLen);
      this.vfd_.setText(text);
      this.vfd_.buildFrames();

      this.testPreviousIcon_ = this.testCurrentIcon_;
      ++this.testCurrentIcon_;
      if (this.testCurrentIcon_ >= kIconCount) this.testCurrentIcon_ = 0;
    }
  }

  IconService.ICON = ICON;
  IconService.kIconCount = kIconCount;
  IconService.kIconNames = kIconNames;

  NS.IconService = IconService;
})(typeof window !== 'undefined' ? window : globalThis);
