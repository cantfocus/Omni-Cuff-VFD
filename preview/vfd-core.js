// VFD preview runtime core: simulated clock, Arduino helpers, Fonts and VfdDriver.
// Mirrors src/VfdDriver.* and src/Fonts.* so the ported services produce the same
// 13-grid x 36-anode bit model the firmware shifts out to the BJ609GK tube.
//
// Conventions shared by every file in web/preview/:
//  - Classic scripts (no ES modules) so the editor works from file://.
//  - Everything hangs off the global namespace `VFDSim`.
//  - Per-grid anode bits are BigInt; bit 0 = P1 (A1) ... bit 35 = P36 (A36).
(function (G) {
  'use strict';
  const NS = G.VFDSim = G.VFDSim || {};

  const MASK36 = (1n << 36n) - 1n;
  NS.MASK36 = MASK36;

  // ── Simulated clock (millis) ──────────────────────────────────
  // The simulator owns time so playback can be paused / restarted.
  let simNow = 0;
  NS.millis = () => simNow >>> 0;
  NS.setMillis = (ms) => { simNow = Math.max(0, Math.floor(ms)); };

  // ── Arduino random() ──────────────────────────────────────────
  // random(max) -> [0, max), random(min, max) -> [min, max)
  NS.random = (a, b) => {
    let lo = 0, hi = a;
    if (b !== undefined) { lo = a; hi = b; }
    if (hi <= lo) return lo;
    return lo + Math.floor(Math.random() * (hi - lo));
  };

  // ── Fonts (src/Fonts.cpp + src/FontPack.cpp) ─────────────────
  const FIRST_CODE = 32, LAST_CODE = 255;
  const packedCache = [];

  function repackGlyph(raw /* 5 column bytes */) {
    // bit index = row*5 + col, LSB-first, padded to 40 bits
    const out = new Uint8Array(5);
    let bit = 0;
    for (let row = 0; row <= 6; ++row) {
      for (let col = 0; col <= 4; ++col) {
        if ((raw[col] >> row) & 1) out[bit >> 3] |= (1 << (bit & 7));
        bit++;
      }
    }
    return out;
  }

  let activeFont = -1;
  NS.Fonts = {
    setActive(idx) {
      const data = NS.FONT_DATA && NS.FONT_DATA[idx];
      if (!data) return false;
      if (!packedCache[idx]) {
        const glyphs = [];
        for (let g = 0; g < 224; ++g) glyphs.push(repackGlyph(data.slice(g * 5, g * 5 + 5)));
        packedCache[idx] = glyphs;
      }
      activeFont = idx;
      return true;
    },
    activeIndex() { return activeFont; },
    // 5 packed bytes (Uint8Array) or null
    glyph(code) {
      if (activeFont < 0) return null;
      if (code < FIRST_CODE || code > LAST_CODE) return null;
      return packedCache[activeFont][code - FIRST_CODE];
    },
    // 5 raw column bytes or null
    glyphRaw(code) {
      if (activeFont < 0) return null;
      if (code < FIRST_CODE || code > LAST_CODE) return null;
      const i = (code - FIRST_CODE) * 5;
      return NS.FONT_DATA[activeFont].slice(i, i + 5);
    },
  };

  // ── VfdDriver (src/VfdDriver.cpp) ────────────────────────────
  const GRID_COUNT = 13, TEXT_FIRST = 5, TEXT_LAST = 12, TEXT_LEN = 8;

  function anodesToBits(a) {
    let bits = 0n;
    bits |= BigInt(a[0] & 0xff);
    bits |= BigInt(a[1] & 0xff) << 8n;
    bits |= BigInt(a[2] & 0xff) << 16n;
    bits |= BigInt(a[3] & 0xff) << 24n;
    bits |= BigInt(a[4] & 0x0f) << 32n;
    return bits & MASK36;
  }
  function bitsToAnodes(bits) {
    const m = BigInt.asUintN(64, bits) & MASK36;
    return new Uint8Array([
      Number(m & 0xffn), Number((m >> 8n) & 0xffn), Number((m >> 16n) & 0xffn),
      Number((m >> 24n) & 0xffn), Number((m >> 32n) & 0x0fn),
    ]);
  }
  const big = (v) => BigInt.asUintN(64, typeof v === 'bigint' ? v : BigInt(v));
  const valid = (g) => g >= 1 && g <= GRID_COUNT;

  class VfdDriver {
    constructor() {
      this.base = new Array(GRID_COUNT).fill(0n);
      this.overlay = new Array(GRID_COUNT).fill(0n);
      this.text = new Array(TEXT_LEN).fill(' ');
      this.powerOn = true;
      this.dirty = true;
      this.frameCount = 0; // increments on every buildFrames() that had changes
    }
    begin() { this.clearAll(); }
    clearAll() { this.clearBase(); this.clearOverlay(); this.text.fill(' '); this.dirty = true; }
    clearBase() { this.base.fill(0n); this.dirty = true; }
    clearOverlay() { this.overlay.fill(0n); this.dirty = true; }

    setText(str) {
      if (str == null) return;
      const s = String(str);
      for (let i = 0; i < TEXT_LEN; ++i) {
        if (i >= s.length || s[i] === '\0') { for (; i < TEXT_LEN; ++i) this.text[i] = ' '; break; }
        this.text[i] = s[i];
      }
      for (let g = TEXT_FIRST; g <= TEXT_LAST; ++g) this._rebuildTextGrid(g);
      this.dirty = true;
    }
    setChar(grid, c) {
      if (grid < TEXT_FIRST || grid > TEXT_LAST) return;
      this.text[grid - TEXT_FIRST] = c;
      this._rebuildTextGrid(grid);
      this.dirty = true;
    }
    _rebuildTextGrid(grid) {
      const c = this.text[grid - TEXT_FIRST];
      const code = typeof c === 'number' ? c : (c ? c.charCodeAt(0) & 0xff : 32);
      const packed = NS.Fonts.glyph(code);
      this.base[grid - 1] = packed ? anodesToBits(packed) : 0n;
    }

    setDisplayPower(on) { this.powerOn = !!on; this.dirty = true; }
    toggleDisplayPower() { this.setDisplayPower(!this.powerOn); }
    isDisplayPowerOn() { return this.powerOn; }

    // Anode-array variants (5 bytes)
    setGridAnodes(g, a) { if (valid(g) && a) { this.base[g - 1] = anodesToBits(a); this.dirty = true; } }
    setOverlayGridAnodes(g, a) { if (valid(g) && a) { this.overlay[g - 1] = anodesToBits(a); this.dirty = true; } }
    andGridAnodes(g, a) { if (valid(g) && a) this.andGridBits(g, anodesToBits(a)); }
    orGridAnodes(g, a) { if (valid(g) && a) this.orGridBits(g, anodesToBits(a)); }
    orNotGridAnodes(g, a) { if (valid(g) && a) this.orNotGridBits(g, anodesToBits(a)); }
    xorGridAnodes(g, a) { if (valid(g) && a) this.xorGridBits(g, anodesToBits(a)); }
    notGridAnodes(g) { this.notGridBits(g); }
    orOverlayGridAnodes(g, a) { if (valid(g) && a) this.orOverlayGridBits(g, anodesToBits(a)); }
    orNotOverlayGridAnodes(g, a) { if (valid(g) && a) this.orNotOverlayGridBits(g, anodesToBits(a)); }
    xorOverlayGridAnodes(g, a) { if (valid(g) && a) this.xorOverlayGridBits(g, anodesToBits(a)); }
    notOverlayGridAnodes(g) { this.notOverlayGridBits(g); }

    // Bit variants (accept BigInt or Number)
    setGridBits(g, b) { if (valid(g)) { this.base[g - 1] = big(b) & MASK36; this.dirty = true; } }
    setOverlayGridBits(g, b) { if (valid(g)) { this.overlay[g - 1] = big(b) & MASK36; this.dirty = true; } }
    andGridBits(g, b) { if (valid(g)) { this.base[g - 1] &= big(b) & MASK36; this.dirty = true; } }
    orGridBits(g, b) { if (valid(g)) { this.base[g - 1] |= big(b) & MASK36; this.dirty = true; } }
    orNotGridBits(g, b) { if (valid(g)) { this.base[g - 1] |= (~big(b)) & MASK36; this.dirty = true; } }
    xorGridBits(g, b) { if (valid(g)) { this.base[g - 1] = (this.base[g - 1] ^ big(b)) & MASK36; this.dirty = true; } }
    notGridBits(g) { if (valid(g)) { this.base[g - 1] = (~this.base[g - 1]) & MASK36; this.dirty = true; } }
    orOverlayGridBits(g, b) { if (valid(g)) { this.overlay[g - 1] |= big(b) & MASK36; this.dirty = true; } }
    orNotOverlayGridBits(g, b) { if (valid(g)) { this.overlay[g - 1] |= (~big(b)) & MASK36; this.dirty = true; } }
    xorOverlayGridBits(g, b) { if (valid(g)) { this.overlay[g - 1] = (this.overlay[g - 1] ^ big(b)) & MASK36; this.dirty = true; } }
    notOverlayGridBits(g) { if (valid(g)) { this.overlay[g - 1] = (~this.overlay[g - 1]) & MASK36; this.dirty = true; } }
    gridBits(g) { return valid(g) ? this.base[g - 1] : 0n; }
    overlayGridBits(g) { return valid(g) ? this.overlay[g - 1] : 0n; }

    buildFrames() { if (this.dirty) { this.frameCount++; this.dirty = false; } }

    // Preview helper: merged (base | overlay) bits for grid 1..13, 0 when powered off.
    litBits(g) {
      if (!valid(g) || !this.powerOn) return 0n;
      return (this.base[g - 1] | this.overlay[g - 1]) & MASK36;
    }
  }
  VfdDriver.kGridCount = GRID_COUNT;
  VfdDriver.kTextGridFirst = TEXT_FIRST;
  VfdDriver.kTextGridLast = TEXT_LAST;
  VfdDriver.kTextLen = TEXT_LEN;
  VfdDriver.anodesToBits = anodesToBits;
  VfdDriver.bitsToAnodes = bitsToAnodes;
  NS.VfdDriver = VfdDriver;
})(typeof window !== 'undefined' ? window : globalThis);
