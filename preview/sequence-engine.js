// VFD preview: port of src/SequenceEngine.h + src/SequenceEngine.cpp.
//
// Runs the same JSON sequence format the firmware accepts (long and short keys,
// kind aliases, afterText scheduling) and drives the ported services on the
// VFDSim namespace. Behaviour, including failure cases and lastError() strings,
// follows the C++ code line by line.
//
// JSON parsing: the firmware uses ArduinoJson 6.21 (DynamicJsonDocument(16384)).
// JSON.parse is NOT used for string input, because it differs from ArduinoJson in
// ways a sequence can hit:
//   - int vs float: ArduinoJson keeps 100 and 100.0 apart, and the engine's
//     asU32 / isTrue / is<int> checks reject floats (so {"atMs": 100.0} falls back
//     to the default on the device).
//   - leniency: single-quoted strings, unquoted keys, raw control chars in strings,
//     leading '+' / '.', and content after the closing brace are all accepted.
//   - limits: nesting depth 10 (TooDeep) and the 16384-byte memory pool
//     (NoMemory). Large sequences run out of pool well before kMaxSteps (96).
// So this file has a small deserializer that copies ArduinoJson 6.21's
// JsonDeserializer and MemoryPool accounting (16-byte slots, deduplicated
// NUL-terminated strings; 32-bit target with ARDUINOJSON_USE_DOUBLE=1 and
// ARDUINOJSON_USE_LONG_LONG=1). Strings are decoded to "byte strings" (one JS char
// per UTF-8 byte) because the device renders text one byte at a time.
// If startSequence() gets an already-parsed object, the object is passed through
// JSON.stringify and then the same deserializer. Whole-number floats such as 1.0
// therefore become integers, since JS can't tell them apart.
(function (G) {
  'use strict';
  const NS = G.VFDSim = G.VFDSim || {};

  const UINT32_MAX = 0xFFFFFFFF;

  // ── ArduinoJson 6.21 deserializer emulation ─────────────────────────────
  const kDocCapacity = 16384;
  const kSlotSize = 16;          // sizeof(VariantSlot) on nRF52 / ESP32 (32-bit, double content)
  const kNestingLimit = 10;      // ARDUINOJSON_DEFAULT_NESTING_LIMIT

  // Floats are boxed so integer-only checks (is<int>, is<uint32_t>) can reject them.
  class JsonFloat { constructor(v) { this.value = v; } }
  const KEEP = {}; // 'null' literal: leaves the variant untouched (ArduinoJson quirk on duplicate keys)

  class ParseError { constructor(code) { this.code = code; } }

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    const s = unescape(encodeURIComponent(str)); // fallback
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; ++i) out[i] = s.charCodeAt(i);
    return out;
  }
  function bytesToString(arr) {
    let s = '';
    for (let i = 0; i < arr.length; i += 4096) s += String.fromCharCode.apply(null, arr.slice(i, i + 4096));
    return s;
  }

  function deserializeJson(input, capacity) {
    let bytes = utf8Bytes(input);
    const nul = bytes.indexOf(0);              // const char* input stops at the first NUL
    if (nul >= 0) bytes = bytes.subarray(0, nul);
    const len = bytes.length;
    let pos = 0;
    let foundSomething = false;
    let strBytes = 0, slots = 0;
    const saved = new Set();

    const cur = () => (pos < len ? bytes[pos] : 0);
    const fail = (code) => { throw new ParseError(code); };
    const isDigit = (c) => c >= 48 && c <= 57;

    function checkStringFits(byteLen) {
      if (strBytes + byteLen + 1 + slots * kSlotSize > capacity) fail('NoMemory');
    }
    function commitString(s) {          // string deduplication (ARDUINOJSON_ENABLE_STRING_DEDUPLICATION)
      if (saved.has(s)) return;
      strBytes += s.length + 1;
      saved.add(s);
    }
    function allocSlot() {
      if (strBytes + (slots + 1) * kSlotSize > capacity) fail('NoMemory');
      slots++;
    }

    function skipSpaces() {
      for (;;) {
        const c = cur();
        if (c === 0) fail(foundSomething ? 'IncompleteInput' : 'EmptyInput');
        if (c === 32 || c === 9 || c === 13 || c === 10) { pos++; continue; }
        foundSomething = true;
        return;
      }
    }
    function eat(ch) { if (cur() === ch) { pos++; return true; } return false; }

    function skipKeyword(word) {
      for (let i = 0; i < word.length; ++i) {
        const c = cur();
        if (c === 0) fail('IncompleteInput');
        if (word.charCodeAt(i) !== c) fail('InvalidInput');
        pos++;
      }
    }

    function decodeHex(c) {
      if (c < 65) return (c - 48) & 0xFF;
      c &= ~0x20;
      return (c - 65 + 10) & 0xFF;
    }
    function readHex4() {
      let r = 0;
      for (let i = 0; i < 4; ++i) {
        const c = cur();
        if (!c) fail('IncompleteInput');
        const v = decodeHex(c);
        if (v > 0x0F) fail('InvalidInput');
        r = ((r << 4) | v) & 0xFFFF;
        pos++;
      }
      return r;
    }
    function pushUtf8(out, cp) {
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F));
      else if (cp < 0x10000) out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      else out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    }
    const ESC = { 47: 47, 34: 34, 92: 92, 98: 8, 102: 12, 110: 10, 114: 13, 116: 9 };

    function parseQuotedString() {
      const stop = cur();
      pos++;
      const out = [];
      let high = 0;
      for (;;) {
        let c = cur();
        pos++;
        if (c === stop) break;
        if (c === 0) fail('IncompleteInput');
        if (c === 92) {
          c = cur();
          if (c === 0) fail('IncompleteInput');
          if (c === 117) { // \uXXXX (ARDUINOJSON_DECODE_UNICODE=1)
            pos++;
            const cu = readHex4();
            if (cu >= 0xD800 && cu < 0xDC00) { high = cu & 0x3FF; continue; }
            const cp = (cu >= 0xDC00 && cu < 0xE000) ? 0x10000 + ((high << 10) | (cu & 0x3FF)) : cu;
            pushUtf8(out, cp);
            continue;
          }
          const u = ESC[c];
          if (u === undefined) fail('InvalidInput');
          c = u;
          pos++;
        }
        out.push(c);
      }
      const s = bytesToString(out);
      checkStringFits(s.length);
      return s;
    }
    const canBeInNonQuoted = (c) => isDigit(c) || c === 95 || (c >= 97 && c <= 122) ||
      (c >= 65 && c <= 90) || c === 43 || c === 45 || c === 46;
    function parseKey() {
      const c = cur();
      if (c === 34 || c === 39) return parseQuotedString();
      if (!canBeInNonQuoted(c)) fail('InvalidInput');
      const out = [];
      while (canBeInNonQuoted(cur())) out.push(bytes[pos++]);
      const s = bytesToString(out);
      checkStringFits(s.length);
      return s;
    }

    const canBeInNumber = (c) => isDigit(c) || c === 43 || c === 45 || c === 46 || c === 101 || c === 69;
    function parseNumber(s) { // returns number (integer), JsonFloat, or null on failure
      let i = 0, neg = false;
      if (s[i] === '-') { neg = true; i++; } else if (s[i] === '+') i++;
      const dig = (ch) => ch !== undefined && ch >= '0' && ch <= '9';
      if (!dig(s[i]) && s[i] !== '.') return null;
      const MAXU = (1n << 64n) - 1n;
      let m = 0n;
      const intStart = i;
      while (dig(s[i])) {
        const d = BigInt(s.charCodeAt(i) - 48);
        if (m > MAXU / 10n) break;
        m *= 10n;
        if (m > MAXU - d) break;
        m += d;
        i++;
      }
      if (i === s.length) {
        if (neg) { if (m <= (1n << 63n)) return m === 0n ? 0 : -Number(m); }
        else return Number(m);
      }
      // Float path: digits [. digits] [e|E [+|-] digits], then end of buffer.
      i = intStart;
      while (dig(s[i])) i++;
      const intPart = s.slice(intStart, i);
      let frac = '', exp = '', expSign = '';
      if (s[i] === '.') { i++; const f0 = i; while (dig(s[i])) i++; frac = s.slice(f0, i); }
      if (s[i] === 'e' || s[i] === 'E') {
        i++;
        if (s[i] === '-' || s[i] === '+') { expSign = s[i]; i++; }
        const e0 = i; while (dig(s[i])) i++; exp = s.slice(e0, i);
      }
      if (i !== s.length) return null;
      const v = Number((intPart || '0') + '.' + (frac || '0') + 'e' + (expSign === '-' ? '-' : '') + (exp || '0'));
      return new JsonFloat(neg ? -v : v);
    }
    function parseNumericValue() {
      let s = '';
      while (s.length < 63 && canBeInNumber(cur())) s += String.fromCharCode(bytes[pos++]);
      const r = parseNumber(s);
      if (r === null) fail('InvalidInput');
      return r;
    }

    function parseArray(limit) {
      if (limit === 0) fail('TooDeep');
      pos++;
      skipSpaces();
      const arr = [];
      if (eat(93)) return arr;
      for (;;) {
        allocSlot();
        const v = parseVariant(limit - 1);
        arr.push(v === KEEP ? null : v);
        skipSpaces();
        if (eat(93)) return arr;
        if (!eat(44)) fail('InvalidInput');
      }
    }
    function parseObject(limit) {
      if (limit === 0) fail('TooDeep');
      pos++;
      skipSpaces();
      const obj = Object.create(null);
      if (eat(125)) return obj;
      for (;;) {
        const key = parseKey();
        skipSpaces();
        if (!eat(58)) fail('InvalidInput');
        if (key in obj) {
          const v = parseVariant(limit - 1);
          if (v !== KEEP) obj[key] = v;
        } else {
          commitString(key);
          allocSlot();
          const v = parseVariant(limit - 1);
          obj[key] = v === KEEP ? null : v;
        }
        skipSpaces();
        if (eat(125)) return obj;
        if (!eat(44)) fail('InvalidInput');
        skipSpaces();
      }
    }
    function parseVariant(limit) {
      skipSpaces();
      const c = cur();
      switch (c) {
        case 91: return parseArray(limit);
        case 123: return parseObject(limit);
        case 34: case 39: {
          const s = parseQuotedString();
          commitString(s);
          const z = s.indexOf('\0');     // consumers treat it as a C string
          return z >= 0 ? s.slice(0, z) : s;
        }
        case 116: skipKeyword('true'); return true;
        case 102: skipKeyword('false'); return false;
        case 110: skipKeyword('null'); return KEEP;
        default: return parseNumericValue();
      }
    }

    try {
      let root = parseVariant(kNestingLimit);
      if (root === KEEP) root = null;
      const enclosed = Array.isArray(root) || isObj(root);
      if (cur() !== 0 && !enclosed) return { error: 'InvalidInput', root: null };
      return { error: null, root };
    } catch (e) {
      if (e instanceof ParseError) return { error: e.code, root: null };
      throw e;
    }
  }

  // ── JsonVariantConst helpers ───────────────────────────────────────────
  function isObj(v) { return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === null; }
  const isArr = (v) => Array.isArray(v);
  const isNull = (v) => v === undefined || v === null;
  const isStr = (v) => typeof v === 'string';
  const isBool = (v) => typeof v === 'boolean';
  const isIntegerVal = (v) => typeof v === 'number';                    // integers only; floats are JsonFloat
  const isInt = (v) => isIntegerVal(v) && v >= -2147483648 && v <= 2147483647;
  const isU32 = (v) => isIntegerVal(v) && v >= 0 && v <= UINT32_MAX;
  const isNumber = (v) => typeof v === 'number' || v instanceof JsonFloat;
  const numVal = (v) => (v instanceof JsonFloat ? v.value : v);
  const member = (obj, k) => (isObj(obj) ? obj[k] : undefined);       // JsonObjectConst::operator[]
  const strOr = (v, fallback) => (isStr(v) ? v : fallback);            // `variant | "default"`

  function getField(obj, k1, k2, k3) {
    let v = member(obj, k1);
    if (!isNull(v)) return v;
    if (k2) { v = member(obj, k2); if (!isNull(v)) return v; }
    if (k3) { v = member(obj, k3); if (!isNull(v)) return v; }
    return undefined;
  }
  const hasField = (obj, k1, k2, k3) => !isNull(getField(obj, k1, k2, k3));

  function isTrue(v, fallback) {
    if (isBool(v)) return v;
    if (isInt(v)) return v !== 0;
    return fallback;
  }
  function asU32(v, fallback) {
    if (isU32(v)) return v;
    if (isInt(v)) return v < 0 ? fallback : v >>> 0;
    return fallback;
  }
  function asFloat(v, fallback) {
    if (isNumber(v)) return Math.fround(numVal(v));
    return fallback;
  }
  function asU8(v, fallback) {
    const value = asU32(v, fallback);
    return value > 255 ? fallback : value;
  }
  // ASCII-only, like tolower() on bytes in the C locale.
  function equalsIgnoreCase(a, b) {
    if (a == null || b == null) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; ++i) {
      let x = a.charCodeAt(i), y = b.charCodeAt(i);
      if (x >= 65 && x <= 90) x += 32;
      if (y >= 65 && y <= 90) y += 32;
      if (x !== y) return false;
    }
    return true;
  }

  // ── Enum lookup (done at call time; services may load after this file) ─
  // Member lists mirror the C++ headers; the index is the fallback numeric value.
  const ENUMS = {
    EqPattern: ['PATTERN_OFF', 'PATTERN_ON', 'PATTERN_BLINK', 'BELL_SWEEP', 'CHEVRON_DN_1X4', 'CHEVRON_DN_2X3',
      'CHEVRON_DN_2X3X1X3', 'CHEVRON_DN_2X4', 'CHEVRON_DN_3X2X1X2X2', 'CHEVRON_DN_3X3X1X3', 'CHEVRON_UP_1X4',
      'CHEVRON_UP_2X3', 'DATA_PROCESSING', 'RIGHT_ARROW_SWEEP', 'SINWAVE', 'TV_STATIC', 'VERTICAL_SINEWAVE',
      'WATER_FALL_1X3', 'WATER_FALL_1X4', 'WATER_FALL_2X5', 'WATERFALL_3X2', 'WATERFALL_4X1', 'MIC_LIVE', 'MIC_PEAK'],
    EqGutter: ['OFF', 'ON', 'BLINK', 'CHASE', 'DOUBLE_CHASE'],
    Pinwheel: ['OFF', 'CHASE', 'FILL_PAUSE_DRAIN_PAUSE', 'CHASE_3', 'CHASE_3_INV'],
    Swoosh: ['OFF', 'SWEEP', 'CHASE', 'CHASE_INV'],
    TopBar: ['OFF', 'SPREAD', 'MARCHING_ANTS', 'DOUBLE_ANTS', 'TRIPLE_ANTS', 'DOUBLE_SPREAD', 'FILL_EMPTY',
      'FILL_RAPID_EMPTY', 'FILL_INV_EMPTY', 'PONG_1X', 'PONG_2X', 'PONG_3X', 'PONG_INV', 'FILL_RETREAT'],
    TextDirection: ['LEFT', 'RIGHT', 'BOUNCE'],
  };
  const ENUM_SOURCE = {
    EqPattern: ['EqService', 'Pattern'],
    EqGutter: ['EqService', 'GutterPattern'],
    Pinwheel: ['DiscService', 'PinwheelPattern'],
    Swoosh: ['DiscService', 'SwooshPattern'],
    TopBar: ['TopBarService', 'Pattern'],
    TextDirection: ['TextService', 'Direction'],
  };
  function enumValue(kind, name) {
    const [cls, en] = ENUM_SOURCE[kind];
    const e = NS[cls] && NS[cls][en];
    if (e && e[name] !== undefined) return e[name];
    return ENUMS[kind].indexOf(name);
  }
  // Static class constants with header values as fallback.
  function classConst(cls, name, fallback) {
    const c = NS[cls];
    return (c && c[name] !== undefined) ? c[name] : fallback;
  }

  const kDiscNames = ['DISC1_EDGE', 'DISC1_HUB', 'DISC2_EDGE', 'DISC2_HUB', 'DISC2_WHEEL', 'DISC3_EDGE', 'DISC3_HUB', 'DISC3_WHEEL'];
  const kIconNamesFallback = ['EON', 'AG', 'G1DOT', 'MONO', 'STEREO_ICN', 'RDS', 'B_ICON', 'C_ICON', 'A_D_G', 'E',
    'DDNR', 'BBE', 'REV_L', 'REV_M', 'REV_R', 'REC_ICN', 'L_SIDE', 'R_SIDE', 'B_SHARP', 'B_BRACKET', 'SHARP_BRACKET',
    'MIC_VF', 'AUTO', 'REC', 'CLOCK_ICN', 'SLEEP', 'T_BASS', 'DSP_SURROUND', 'GRAPHIC_EQ', 'RANDOM', 'PRGM', 'EDIT',
    'RPLY_ICN', 'KHZ', 'MHZ'];
  const DISC_COUNT = 8;
  const ICON_COUNT = 35;

  // Sequence defaults (anonymous namespace in SequenceEngine.cpp)
  const kSeqDefaultTextScrollCount = 2;
  const kSeqDefaultTextScrollSpeedMs = 100;
  const kSeqDefaultTextFontIndex = 0;
  const kSeqDefaultTextFlashRepeats = 3;
  const kSeqDefaultTextFlashOnMs = 400;
  const kSeqDefaultTextFlashOffMs = 200;
  const kSeqDefaultEqBarPeriodMs = 120;
  const kSeqDefaultEqGutterPeriodMs = 220;
  const kSeqDefaultPinwheelPeriodMs = 140;
  const kSeqDefaultSwooshPeriodMs = 160;
  const kSeqDefaultTopBarPeriodMs = 140;
  const kSeqDefaultTrackAnimStepMs = 80;
  const kSeqDefaultTrackSwirlPeriodMs = 500;
  const kSeqDefaultCounterStepMs = 40;
  const kSeqDefaultCounterRollFrameMs = 25;
  const kSeqDefaultCounterBlankRows = 1;

  const kMaxSteps = 96;

  // Flow control (port of SequenceEngine wait/goto).
  const kTargetNext = -1, kTargetEnd = -2, kTargetNone = -3, kTargetLast = -4;
  const INPUTS = ['up', 'down', 'left', 'right', 'select'];
  const kTimeoutSlot = INPUTS.length;
  const kDefaultWaitTimeoutMs = 30000;
  const kMaxJumpsPerUpdate = 16;
  const EndReason = Object.freeze({ NONE: 'none', COMPLETED: 'completed', INPUT_END: 'input_end', STOPPED: 'stopped', ERROR: 'error' });

  const SequenceTag = Object.freeze({ FOREGROUND: 0, BACKGROUND: 1, IDLE: 2, CRITICAL: 3 });

  // ── Name parsers (return enum value or null) ───────────────────────────
  function parseTag(tagName) {
    if (equalsIgnoreCase(tagName, 'idle')) return SequenceTag.IDLE;
    if (equalsIgnoreCase(tagName, 'background')) return SequenceTag.BACKGROUND;
    if (equalsIgnoreCase(tagName, 'critical')) return SequenceTag.CRITICAL;
    return SequenceTag.FOREGROUND;
  }
  function parseEqPattern(name) {
    if (equalsIgnoreCase(name, 'PATTERN_OFF') || equalsIgnoreCase(name, 'OFF')) return enumValue('EqPattern', 'PATTERN_OFF');
    if (equalsIgnoreCase(name, 'PATTERN_ON') || equalsIgnoreCase(name, 'ON')) return enumValue('EqPattern', 'PATTERN_ON');
    if (equalsIgnoreCase(name, 'PATTERN_BLINK') || equalsIgnoreCase(name, 'BLINK')) return enumValue('EqPattern', 'PATTERN_BLINK');
    for (const n of ENUMS.EqPattern.slice(3)) {
      if (equalsIgnoreCase(name, n)) return enumValue('EqPattern', n);
    }
    return null;
  }
  function parseByNames(kind, name) {
    for (const n of ENUMS[kind]) if (equalsIgnoreCase(name, n)) return enumValue(kind, n);
    return null;
  }
  function parseTopBarPattern(name) {
    const list = ENUMS.TopBar;
    for (let i = 0; i < list.length; ++i) {
      if (equalsIgnoreCase(name, list[i]) || equalsIgnoreCase(name, 'PATTERN_' + i) ||
          (i > 0 && equalsIgnoreCase(name, String(i)))) {   // "0" is NOT accepted for OFF in the C++
        return enumValue('TopBar', list[i]);
      }
    }
    return null;
  }
  // Returns one of 'NONE','COUNT_UP',... or null
  function parseTrackAnimation(name) {
    if (equalsIgnoreCase(name, 'none') || equalsIgnoreCase(name, 'stop')) return 'NONE';
    for (const n of ['count_up', 'fill_up', 'count_down', 'filled_down', 'count_down_warning', 'random_toggle', 'notif_count']) {
      if (equalsIgnoreCase(name, n)) return n.toUpperCase();
    }
    return null;
  }
  function parseDiscByName(name) {
    for (let i = 0; i < DISC_COUNT; ++i) if (equalsIgnoreCase(name, kDiscNames[i])) return i;
    return null;
  }
  function iconName(i) {
    const IS = NS.IconService;
    return (IS && typeof IS.toCString === 'function') ? IS.toCString(i) : kIconNamesFallback[i];
  }
  function parseIconByName(name) {
    const count = classConst('IconService', 'kIconCount', ICON_COUNT);
    for (let i = 0; i < count; ++i) if (equalsIgnoreCase(name, iconName(i))) return i;
    return null;
  }

  // ── SequenceEngine ─────────────────────────────────────────────────────
  class SequenceEngine {
    constructor(vfd, eqService, iconService, trackService, discService, topBarService, textService, numberCounterService) {
      this.vfd_ = vfd;
      this.eqService_ = eqService;
      this.iconService_ = iconService;
      this.trackService_ = trackService;
      this.discService_ = discService;
      this.topBarService_ = topBarService;
      this.textService_ = textService;
      this.numberCounterService_ = numberCounterService;

      this.doc_ = null;
      this.stepAtMs_ = new Array(kMaxSteps).fill(0);
      this.stepAfterTextOffset_ = new Array(kMaxSteps).fill(0);
      this.stepAfterTextAnchor_ = new Array(kMaxSteps).fill(false);
      this.stepCount_ = 0;
      this.nextStepIndex_ = 0;
      this.sequenceStartMs_ = 0;
      this.running_ = false;
      this.textWasRunning_ = false;
      this.textAnimationArmed_ = false;
      this.afterTextAnchorValid_ = false;
      this.afterTextAnchorMs_ = 0;
      this.lastSequenceCompletedMs_ = 0;
      this.currentTag_ = SequenceTag.FOREGROUND;
      this.interruptible_ = false;
      this.lastError_ = '';
      this.lastFailedStepIndex_ = -1;
      this.lastFailedActionKind_ = '';
      this.clockService_ = null;
    }

    setClockService(clock) { this.clockService_ = clock; }
    stopClock_() { if (this.clockService_) this.clockService_.stop(); }

    // Port of SequenceEngine::expandTokens. Token values come from
    // VFDSim.tokenContext ({title, message, app, kind, time}), which the
    // editor's ANCS tab fills with test values.
    expandTokens_(str, stripCommas = false) {
      const ctx = NS.tokenContext || null;
      return String(str).replace(/\{([a-zA-Z]{1,8}|[xX][0-9a-fA-F]{2})\}/g, (m, name) => {
        const key = name.toLowerCase();
        let v;
        const hex = /^x([0-9a-f]{2})$/.exec(key);
        if (hex) {
          // {xNN}: raw font code 0x20..0xFF, not comma-stripped.
          const code = parseInt(hex[1], 16);
          return code >= 0x20 ? String.fromCharCode(code) : m;
        }
        if (key === 'now') {
          const t = NS.clockNow ? NS.clockNow() : null;
          v = t ? `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}` : '--:--';
        } else if (key === 'pos' || key === 'count') {
          v = ctx && ctx[key] ? String(ctx[key]) : '';
        } else if (['title', 'message', 'msg', 'app', 'kind', 'time'].includes(key)) {
          v = ctx ? String(ctx[key === 'msg' ? 'message' : key] || '') : '';
        } else {
          return m; // unknown token: left as typed
        }
        return stripCommas ? v.replace(/,/g, ' ') : v;
      }).slice(0, 255);
    }

    // json: string (parsed like ArduinoJson) or an already-parsed object (stringified first).
    startSequence(json, forceInterrupt = false) {
      this.lastFailedStepIndex_ = -1;
      this.lastFailedActionKind_ = '';
      this.textAnimationArmed_ = false;
      this.afterTextAnchorValid_ = false;

      if (this.running_ && !forceInterrupt && !this.canInterruptCurrentSequence()) {
        this.lastError_ = 'sequence currently non-interruptible';
        return false;
      }
      if (this.running_) this.stopSequence();

      let text;
      if (typeof json === 'string') text = json;
      else if (json !== null && typeof json === 'object') text = JSON.stringify(json);
      else text = '';
      if (!this.parseAndPrepare_(text)) return false;
      this.stopClock_(); // the clock belongs to the sequence that started it

      this.vfd_.setDisplayPower(true);
      this.sequenceStartMs_ = NS.millis();
      this.nextStepIndex_ = 0;
      this.waiting_ = false;
      this.inputStep_ = -1;
      this.endReason_ = EndReason.NONE;
      this.running_ = true;
      return true;
    }

    update(now) {
      if (!this.running_) return;
      now = now >>> 0;

      if (this.waiting_) {
        if (((now - this.waitStartMs_) >>> 0) < this.stepWaitTimeoutMs_[this.waitStep_]) return;
        this.waiting_ = false;
        this.jumpTo_(this.stepWait_[this.waitStep_][kTimeoutSlot], this.waitStep_, now, false);
        if (!this.running_) return;
      }

      let elapsed = (now - this.sequenceStartMs_) >>> 0;

      const serviceTextRunning = this.textService_.isRunning();
      if (this.textAnimationArmed_ && !serviceTextRunning) this.textAnimationArmed_ = false;
      const textIsRunning = serviceTextRunning && this.textAnimationArmed_;

      if (this.textWasRunning_ && !textIsRunning) {
        this.afterTextAnchorMs_ = elapsed;
        this.afterTextAnchorValid_ = true;
      }

      if (!textIsRunning && this.nextStepIndex_ < this.stepCount_ && this.stepAtMs_[this.nextStepIndex_] === UINT32_MAX) {
        const baseMs = this.afterTextAnchorValid_ ? this.afterTextAnchorMs_ : elapsed;
        for (let i = this.nextStepIndex_; i < this.stepCount_; ++i) {
          if (this.stepAtMs_[i] !== UINT32_MAX) continue;
          if (i !== this.nextStepIndex_ && this.stepAfterTextAnchor_[i]) break;
          this.stepAtMs_[i] = (baseMs + this.stepAfterTextOffset_[i]) >>> 0;
        }
      }
      this.textWasRunning_ = textIsRunning;

      const steps = getField(this.doc_, 'steps', 's');
      let jumps = 0;
      while (this.nextStepIndex_ < this.stepCount_ && elapsed >= this.stepAtMs_[this.nextStepIndex_]) {
        const idx = this.nextStepIndex_;
        this.lastFailedStepIndex_ = idx;
        const step = isArr(steps) ? steps[idx] : undefined;
        if (!this.executeStep_(isObj(step) ? step : null)) {
          this.stopSequence();
          this.endReason_ = EndReason.ERROR;
          return;
        }
        ++this.nextStepIndex_;
        // This step's input targets stay live until the next step runs or a jump.
        this.inputStep_ = this.stepHasInput_[idx] ? idx : -1;
        if (this.onStep) this.onStep(idx); // preview hook: which step just ran

        if (this.stepHasWait_[idx]) {
          this.waiting_ = true;
          this.waitStep_ = idx;
          this.waitStartMs_ = now;
          return;
        }
        if (this.stepGoto_[idx] !== kTargetNone) {
          this.jumpTo_(this.stepGoto_[idx], idx, now, false);
          if (!this.running_) return;
          elapsed = (now - this.sequenceStartMs_) >>> 0;
          if (++jumps >= kMaxJumpsPerUpdate) return;
        }
      }

      if (this.nextStepIndex_ >= this.stepCount_) {
        const finalTextRunning = this.textService_.isRunning() && this.textAnimationArmed_;
        if (!finalTextRunning) this.finish_(EndReason.COMPLETED, now);
      }
    }

    finish_(reason, now) {
      this.lastSequenceCompletedMs_ = now;
      this.running_ = false;
      this.waiting_ = false;
      this.inputStep_ = -1;
      this.endReason_ = reason;
    }

    resolveTarget_(target, owner) {
      if (target === kTargetNext) return (owner + 1 < this.stepCount_) ? owner + 1 : kTargetEnd;
      if (target === kTargetLast) return this.stepCount_ ? this.stepCount_ - 1 : kTargetEnd;
      return target;
    }

    jumpTo_(target, owner, now, fromInput) {
      target = this.resolveTarget_(target, owner);
      if (target < 0 || target >= this.stepCount_) {
        this.finish_(fromInput ? EndReason.INPUT_END : EndReason.COMPLETED, now);
        return;
      }
      const k = target;
      for (let i = k; i < this.stepCount_; ++i) this.stepAtMs_[i] = this.stepOrigAtMs_[i];
      this.afterTextAnchorValid_ = false;
      this.textWasRunning_ = this.textService_.isRunning() && this.textAnimationArmed_;
      if (this.stepOrigAtMs_[k] !== UINT32_MAX) this.sequenceStartMs_ = (now - this.stepOrigAtMs_[k]) >>> 0;
      else this.stepAtMs_[k] = (now - this.sequenceStartMs_) >>> 0;
      this.nextStepIndex_ = k;
      this.waiting_ = false;
      this.inputStep_ = -1;
    }

    // Button targets in effect now: the active wait's, else the current
    // step's non-blocking input targets, else null.
    activeTargets_() {
      if (!this.running_) return null;
      if (this.waiting_) return this.stepWait_[this.waitStep_];
      if (this.inputStep_ >= 0) return this.stepInput_[this.inputStep_];
      return null;
    }

    // input: 'up' | 'down' | 'left' | 'right' | 'select'. Returns true if the
    // sequence (active wait or step input) handles it (and jumped).
    handleInput(input) {
      const slot = INPUTS.indexOf(String(input).toLowerCase());
      const targets = this.activeTargets_();
      if (!targets || slot < 0) return false;
      const target = targets[slot];
      if (target === kTargetNone) return false;
      const owner = this.waiting_ ? this.waitStep_ : this.inputStep_;
      this.waiting_ = false;
      this.jumpTo_(target, owner, NS.millis(), true);
      return true;
    }

    isWaitingForInput() { return this.running_ && this.waiting_; }
    // Names of the buttons the sequence handles right now (wait or step input).
    waitInputs() {
      const t = this.activeTargets_();
      if (!t) return [];
      return INPUTS.filter((_, i) => t[i] !== kTargetNone);
    }
    // Step whose non-blocking input targets are live (-1 if none / waiting).
    inputStepIndex() { return (this.running_ && !this.waiting_) ? this.inputStep_ : -1; }
    waitRemainingMs(now) {
      if (!this.isWaitingForInput()) return 0;
      const el = (now - this.waitStartMs_) >>> 0;
      const lim = this.stepWaitTimeoutMs_[this.waitStep_];
      return el >= lim ? 0 : lim - el;
    }
    waitStepIndex() { return this.isWaitingForInput() ? this.waitStep_ : -1; }

    // Preview-only: start mid-sequence. Runs the actions of steps before k
    // instantly (no timing, waits or gotos) so icons/EQ/top bar etc. are in
    // the state those steps leave them, then jumps to k, which runs at once.
    skipTo(k) {
      if (!this.running_ || k <= 0) return true;
      k = Math.min(k, this.stepCount_ - 1);
      const steps = getField(this.doc_, 'steps', 's');
      for (let i = 0; i < k; ++i) {
        this.lastFailedStepIndex_ = i;
        const step = isArr(steps) ? steps[i] : undefined;
        if (!this.executeStep_(isObj(step) ? step : null)) {
          this.stopSequence();
          this.endReason_ = EndReason.ERROR;
          return false;
        }
      }
      this.jumpTo_(k, k - 1, NS.millis(), false);
      return true;
    }
    lastEndReason() { return this.endReason_; }

    stopSequence() {
      if (this.running_) {
        this.lastSequenceCompletedMs_ = NS.millis();
        this.endReason_ = EndReason.STOPPED;
      }
      this.running_ = false;
      this.waiting_ = false;
      this.inputStep_ = -1;
      this.stepCount_ = 0;
      this.nextStepIndex_ = 0;
      this.interruptible_ = false;
      this.textWasRunning_ = false;
      this.textAnimationArmed_ = false;
      this.afterTextAnchorValid_ = false;
      this.afterTextAnchorMs_ = 0;
      this.currentTag_ = SequenceTag.FOREGROUND;
      this.doc_ = null;
    }

    isSequenceRunning() { return this.running_; }
    canInterruptCurrentSequence() { return this.running_ ? this.interruptible_ : true; }
    currentTag() { return this.currentTag_; }
    lastError() { return this.lastError_; }
    lastSequenceCompletedMs() { return this.lastSequenceCompletedMs_; }
    lastFailedStepIndex() { return this.lastFailedStepIndex_; }
    lastFailedActionKind() { return this.lastFailedActionKind_; }

    // ── Preview-only helpers (not part of the firmware API) ────────────────
    // Schedule of the loaded sequence: atMs is ms since sequence start, or null
    // for afterText-dependent steps that haven't been resolved yet.
    stepTimeline() {
      const out = [];
      for (let i = 0; i < this.stepCount_; ++i) {
        out.push({ index: i, atMs: this.stepAtMs_[i] === UINT32_MAX ? null : this.stepAtMs_[i] });
      }
      return out;
    }
    // Index of the next step to execute (== step count once all have run).
    nextStepIndex() { return this.nextStepIndex_; }

    // ── private ────────────────────────────────────────────────────────────
    parseAndPrepare_(json) {
      this.lastError_ = '';
      this.lastFailedStepIndex_ = -1;
      this.lastFailedActionKind_ = '';
      this.textAnimationArmed_ = false;
      this.afterTextAnchorValid_ = false;
      this.afterTextAnchorMs_ = 0;
      this.doc_ = null;

      const res = deserializeJson(json, kDocCapacity);
      if (res.error) {
        this.lastError_ = 'json parse error: ' + res.error;
        return false;
      }
      this.doc_ = res.root;

      const root = isObj(res.root) ? res.root : null;
      const steps = getField(root, 'steps', 's');
      if (!isArr(steps) || steps.length === 0) {
        this.lastError_ = 'sequence requires non-empty steps array';
        return false;
      }
      if (steps.length > kMaxSteps) {
        this.lastError_ = 'too many steps for fixed scheduler';
        return false;
      }

      const tagName = strOr(getField(root, 'tag', 't'), 'foreground');
      this.currentTag_ = parseTag(tagName);
      this.interruptible_ = (this.currentTag_ === SequenceTag.BACKGROUND) || (this.currentTag_ === SequenceTag.IDLE);
      const interruptibleNode = getField(root, 'interruptible', 'i');
      if (isBool(interruptibleNode)) this.interruptible_ = interruptibleNode;

      this.textWasRunning_ = false;
      this.stepOrigAtMs_ = new Array(kMaxSteps).fill(0);
      this.stepGoto_ = new Array(kMaxSteps).fill(kTargetNone);
      this.stepHasWait_ = new Array(kMaxSteps).fill(false);
      this.stepWait_ = Array.from({ length: kMaxSteps }, () => new Array(kTimeoutSlot + 1).fill(kTargetNone));
      this.stepWaitTimeoutMs_ = new Array(kMaxSteps).fill(kDefaultWaitTimeoutMs);
      this.stepHasInput_ = new Array(kMaxSteps).fill(false);
      this.stepInput_ = Array.from({ length: kMaxSteps }, () => new Array(INPUTS.length).fill(kTargetNone));
      let cursorMs = 0;
      let afterTextMode = false;
      let afterTextCursor = 0;
      let prevTimingWasAfterText = false;
      this.stepCount_ = 0;

      for (const step of steps) {
        if (!isObj(step)) {
          this.lastError_ = 'each step must be an object';
          return false;
        }
        const n = this.stepCount_;
        if (hasField(step, 'afterText', 'axt', 'waitAfterText')) {
          const delta = asU32(getField(step, 'afterText', 'axt', 'waitAfterText'), 0);
          if (afterTextMode && prevTimingWasAfterText) afterTextCursor = (afterTextCursor + delta) >>> 0;
          else afterTextCursor = delta;
          afterTextMode = true;
          this.stepAtMs_[n] = UINT32_MAX;
          this.stepAfterTextOffset_[n] = afterTextCursor;
          this.stepAfterTextAnchor_[n] = true;
          prevTimingWasAfterText = true;
        } else if (hasField(step, 'atMs', 'a')) {
          cursorMs = asU32(getField(step, 'atMs', 'a'), cursorMs);
          afterTextMode = false;
          this.stepAtMs_[n] = cursorMs;
          this.stepAfterTextOffset_[n] = 0;
          this.stepAfterTextAnchor_[n] = false;
          prevTimingWasAfterText = false;
        } else if (hasField(step, 'waitMs', 'w')) {
          const delta = asU32(getField(step, 'waitMs', 'w'), 0);
          if (afterTextMode) {
            afterTextCursor = (afterTextCursor + delta) >>> 0;
            this.stepAtMs_[n] = UINT32_MAX;
            this.stepAfterTextOffset_[n] = afterTextCursor;
            this.stepAfterTextAnchor_[n] = false;
          } else {
            cursorMs = (cursorMs + delta) >>> 0;
            this.stepAtMs_[n] = cursorMs;
            this.stepAfterTextOffset_[n] = 0;
            this.stepAfterTextAnchor_[n] = false;
          }
          prevTimingWasAfterText = false;
        } else {
          if (afterTextMode) {
            this.stepAtMs_[n] = UINT32_MAX;
            this.stepAfterTextOffset_[n] = afterTextCursor;
            this.stepAfterTextAnchor_[n] = false;
          } else {
            this.stepAtMs_[n] = cursorMs;
            this.stepAfterTextOffset_[n] = 0;
            this.stepAfterTextAnchor_[n] = false;
          }
          prevTimingWasAfterText = false;
        }

        let actionsNode = getField(step, 'actions', 'x', 'do');
        if (isNull(actionsNode)) actionsNode = member(step, 'd');
        if (isNull(actionsNode)) {
          this.lastError_ = 'step missing actions/do';
          return false;
        }
        this.stepOrigAtMs_[n] = this.stepAtMs_[n];
        if (!this.parseFlow_(step, n, steps.length)) {
          this.lastFailedStepIndex_ = n;
          return false;
        }
        ++this.stepCount_;
      }
      return true;
    }

    // Target: 1-based step number, "next", "last" or "end". Returns null if invalid.
    parseTarget_(v, total) {
      let n = -1;
      if (typeof v === 'number' && Number.isInteger(v)) n = v;
      else if (typeof v === 'string') {
        if (equalsIgnoreCase(v, 'next')) return kTargetNext;
        if (equalsIgnoreCase(v, 'end')) return kTargetEnd;
        if (equalsIgnoreCase(v, 'last')) return kTargetLast;
        if (/^-?\d+$/.test(v)) n = parseInt(v, 10);
      }
      if (n < 1 || n > total) return null;
      return n - 1;
    }

    parseFlow_(step, index, total) {
      const waitNode = getField(step, 'wait', 'wi');
      if (!isNull(waitNode)) {
        if (!isObj(waitNode)) { this.lastError_ = `step ${index + 1}: wait must be an object`; return false; }
        this.stepHasWait_[index] = true;
        for (let b = 0; b < INPUTS.length; ++b) {
          const t = member(waitNode, INPUTS[b]);
          if (isNull(t)) continue;
          const r = this.parseTarget_(t, total);
          if (r === null) { this.lastError_ = `step ${index + 1}: bad wait.${INPUTS[b]} target`; return false; }
          this.stepWait_[index][b] = r;
        }
        this.stepWaitTimeoutMs_[index] = asU32(getField(waitNode, 'timeoutMs', 'tm'), kDefaultWaitTimeoutMs);
        const tt = getField(waitNode, 'timeout', 'tg');
        this.stepWait_[index][kTimeoutSlot] = kTargetNext;
        if (!isNull(tt)) {
          const r = this.parseTarget_(tt, total);
          if (r === null) { this.lastError_ = `step ${index + 1}: bad wait.timeout target`; return false; }
          this.stepWait_[index][kTimeoutSlot] = r;
        }
        return true;
      }
      // Non-blocking input: the timeline keeps running; a listed button jumps.
      const inputNode = getField(step, 'input', 'ip');
      if (!isNull(inputNode)) {
        if (!isObj(inputNode)) { this.lastError_ = `step ${index + 1}: input must be an object`; return false; }
        this.stepHasInput_[index] = true;
        for (let b = 0; b < INPUTS.length; ++b) {
          const t = member(inputNode, INPUTS[b]);
          if (isNull(t)) continue;
          const r = this.parseTarget_(t, total);
          if (r === null) { this.lastError_ = `step ${index + 1}: bad input.${INPUTS[b]} target`; return false; }
          this.stepInput_[index][b] = r;
        }
      }
      const g = getField(step, 'goto', 'go');
      if (!isNull(g)) {
        const r = this.parseTarget_(g, total);
        if (r === null) { this.lastError_ = `step ${index + 1}: bad goto target`; return false; }
        this.stepGoto_[index] = r;
      }
      return true;
    }

    executeStep_(step) {
      let actionsNode = getField(step, 'actions', 'x', 'do');
      if (isNull(actionsNode)) actionsNode = member(step, 'd');
      if (isNull(actionsNode)) {
        this.lastError_ = 'step missing actions at execution';
        return false;
      }
      return this.executeActions_(actionsNode);
    }

    executeActions_(actionsNode) {
      if (isArr(actionsNode)) {
        for (const action of actionsNode) {
          if (!isObj(action)) {
            this.lastError_ = 'action entry must be an object';
            return false;
          }
          if (!this.executeAction_(action)) return false;
        }
        return true;
      }
      if (isObj(actionsNode)) return this.executeAction_(actionsNode);
      this.lastError_ = 'actions must be array or object';
      return false;
    }

    executeAction_(action) {
      let kind = strOr(getField(action, 'kind', 'k'), '');
      if (kind.length === 0) {
        this.lastError_ = 'action missing kind';
        return false;
      }

      const ALIASES = [
        ['ao', 'all.off'], ['vp', 'vfd.power'], ['vt', 'vfd.text'], ['ts', 'text.scroll'], ['tp', 'text.stop'],
        ['tf', 'text.flash'], ['eq', 'eq.set'], ['es', 'eq.set'], ['dp', 'disc.pinwheel'], ['ds', 'disc.swoosh'],
        ['db', 'disc.bits'], ['is', 'icon.set'], ['tb', 'topbar.set'], ['ta', 'track.anim'], ['tn', 'track.numbers'],
        ['tw', 'track.swirl'], ['cs', 'counter.start'], ['cx', 'counter.stop'],
        ['ck', 'clock.show'], ['ckx', 'clock.stop'],
      ];
      for (const [short, full] of ALIASES) {
        if (equalsIgnoreCase(kind, short)) { kind = full; break; }
      }
      this.lastFailedActionKind_ = kind;

      const vfd = this.vfd_, eq = this.eqService_, icons = this.iconService_, track = this.trackService_;
      const disc = this.discService_, topBar = this.topBarService_, text = this.textService_;
      const counter = this.numberCounterService_;

      if (equalsIgnoreCase(kind, 'all.off')) {
        text.stop();
        this.textAnimationArmed_ = false;
        this.afterTextAnchorValid_ = false;
        vfd.setText(' ');
        track.stopAnimation();
        track.offAll();
        track.stopSwirlBlink();
        track.setSwirl(false);
        eq.disable();
        disc.setPinwheelEnabled(false);
        disc.setSwooshEnabled(false);
        topBar.setAnimationEnabled(false);
        topBar.offAll();
        icons.clearAll();
        disc.offAll();
        counter.stop();
        this.stopClock_();
        return true;
      }

      if (equalsIgnoreCase(kind, 'vfd.power')) {
        vfd.setDisplayPower(isTrue(getField(action, 'on', 'o'), true));
        return true;
      }
      if (equalsIgnoreCase(kind, 'vfd.text')) {
        const str = this.expandTokens_(strOr(getField(action, 'text', 't'), ''));
        const font = asU8(getField(action, 'font', 'f'), 0);
        this.stopClock_();
        NS.Fonts.setActive(font);
        vfd.setText(str);
        vfd.buildFrames();
        return true;
      }
      if (equalsIgnoreCase(kind, 'text.scroll')) {
        const str = this.expandTokens_(strOr(getField(action, 'text', 't'), ''));
        const count = asU32(getField(action, 'count', 'c'), kSeqDefaultTextScrollCount) & 0xFFFF;
        const speedMs = asU32(getField(action, 'speedMs', 'sm'), kSeqDefaultTextScrollSpeedMs);
        const font = asU8(getField(action, 'font', 'f'), kSeqDefaultTextFontIndex);
        let direction = classConst('TextService', 'kDefaultDirection', enumValue('TextDirection', 'LEFT'));
        const directionNode = getField(action, 'direction', 'd');
        if (isStr(directionNode)) {
          const parsed = parseByNames('TextDirection', directionNode);
          if (parsed !== null) direction = parsed;
        }
        const noLead = isTrue(getField(action, 'noLead', 'nl'), false);
        const noTrail = isTrue(getField(action, 'noTrail', 'nt'), false);
        this.stopClock_();
        text.startScroll(str, count, speedMs, direction, font, noLead, noTrail);
        this.textAnimationArmed_ = !!text.isRunning();
        if (this.textAnimationArmed_) this.afterTextAnchorValid_ = false;
        return true;
      }
      if (equalsIgnoreCase(kind, 'text.stop')) {
        text.stop();
        this.textAnimationArmed_ = false;
        this.afterTextAnchorValid_ = false;
        return true;
      }
      if (equalsIgnoreCase(kind, 'text.flash')) {
        const raw = this.expandTokens_(strOr(getField(action, 'texts', 'tt'), ''), true);
        const count = asU32(getField(action, 'count', 'c'), kSeqDefaultTextFlashRepeats) & 0xFFFF;
        const onMs = asU32(getField(action, 'onMs', 'on'), kSeqDefaultTextFlashOnMs);
        const offMs = asU32(getField(action, 'offMs', 'om'), kSeqDefaultTextFlashOffMs);
        const font = asU8(getField(action, 'font', 'f'), kSeqDefaultTextFontIndex);

        // strncpy into a 12 * (kTextLen + 1) = 108 byte buffer (107 chars + NUL), then strtok_r on ','
        // (empty tokens skipped), at most 12 tokens.
        const kMax = 12;
        const textLen = (NS.VfdDriver && NS.VfdDriver.kTextLen) || 8;
        const truncated = raw.slice(0, kMax * (textLen + 1) - 1);
        const ptrs = truncated.split(',').filter((t) => t.length > 0).slice(0, kMax);
        if (ptrs.length > 0) {
          this.stopClock_();
          text.startFlashLines(ptrs, ptrs.length, count, onMs, offMs, font);
          this.textAnimationArmed_ = !!text.isRunning();
          if (this.textAnimationArmed_) this.afterTextAnchorValid_ = false;
        }
        return true;
      }
      if (equalsIgnoreCase(kind, 'eq.set')) {
        let pattern = enumValue('EqPattern', 'SINWAVE');
        let gutter = enumValue('EqGutter', 'CHASE');
        const patternNode = getField(action, 'pattern', 'p');
        const gutterNode = getField(action, 'gutterPattern', 'g');
        let hasPattern = false, hasGutter = false;
        if (isStr(patternNode)) { const p = parseEqPattern(patternNode); if (p !== null) { pattern = p; hasPattern = true; } }
        if (isStr(gutterNode)) { const g = parseByNames('EqGutter', gutterNode); if (g !== null) { gutter = g; hasGutter = true; } }
        const hasBarPeriod = hasField(action, 'barPeriodMs', 'bp');
        const hasGutterPeriod = hasField(action, 'gutterPeriodMs', 'gp');
        const hasEnabled = hasField(action, 'enabled', 'e');
        let configured = false;

        if (!hasPattern && !hasGutter && !hasBarPeriod && !hasGutterPeriod && !hasEnabled) {
          eq.setPattern(enumValue('EqPattern', 'SINWAVE'), kSeqDefaultEqBarPeriodMs,
            enumValue('EqGutter', 'CHASE'), kSeqDefaultEqGutterPeriodMs);
          eq.enable();
          return true;
        }

        if (hasPattern) {
          const effectiveGutter = hasGutter ? gutter : enumValue('EqGutter', 'CHASE');
          eq.setPattern(pattern,
            asU32(getField(action, 'barPeriodMs', 'bp'), kSeqDefaultEqBarPeriodMs),
            effectiveGutter,
            asU32(getField(action, 'gutterPeriodMs', 'gp'), kSeqDefaultEqGutterPeriodMs));
          configured = true;
        } else if (hasGutter || hasGutterPeriod) {
          const effectiveGutter = hasGutter ? gutter : enumValue('EqGutter', 'CHASE');
          eq.setGutterPattern(effectiveGutter, asU32(getField(action, 'gutterPeriodMs', 'gp'), kSeqDefaultEqGutterPeriodMs));
          configured = true;
        }

        if (hasEnabled) {
          if (isTrue(getField(action, 'enabled', 'e'), true)) eq.enable();
          else eq.disable();
        } else if (configured) {
          eq.enable();
        }
        return true;
      }
      if (equalsIgnoreCase(kind, 'disc.pinwheel')) {
        let pattern = enumValue('Pinwheel', 'CHASE');
        const patternNode = getField(action, 'pattern', 'p');
        if (isStr(patternNode)) { const p = parseByNames('Pinwheel', patternNode); if (p !== null) pattern = p; }
        disc.setPinwheelPattern(pattern);
        disc.setPinwheelEnabled(isTrue(getField(action, 'enabled', 'e'), true));
        disc.setPinwheelDirection(isTrue(getField(action, 'forward', 'fw'), true));
        disc.setPinwheelReverse(isTrue(getField(action, 'reverse', 'rv'), false));
        disc.setPinwheelPeriod(asU32(getField(action, 'periodMs', 'pm'), kSeqDefaultPinwheelPeriodMs));
        return true;
      }
      if (equalsIgnoreCase(kind, 'disc.swoosh')) {
        let pattern = enumValue('Swoosh', 'SWEEP');
        const patternNode = getField(action, 'pattern', 'p');
        if (isStr(patternNode)) { const p = parseByNames('Swoosh', patternNode); if (p !== null) pattern = p; }
        disc.setSwooshPattern(pattern);
        disc.setSwooshEnabled(isTrue(getField(action, 'enabled', 'e'), true));
        disc.setSwooshDirection(isTrue(getField(action, 'forward', 'fw'), true));
        disc.setSwooshReverse(isTrue(getField(action, 'reverse', 'rv'), false));
        disc.setSwooshPeriod(asU32(getField(action, 'periodMs', 'pm'), kSeqDefaultSwooshPeriodMs));
        return true;
      }
      if (equalsIgnoreCase(kind, 'disc.bits')) {
        if (isTrue(member(action, 'allOn'), false)) disc.onAll();
        if (isTrue(member(action, 'allOff'), false)) disc.offAll();
        const discCount = DISC_COUNT;
        const applyArray = (node, mode) => {
          if (!isArr(node)) return;
          for (const item of node) {
            let d = null;
            if (isStr(item)) d = parseDiscByName(item);
            else if (isInt(item) && item >= 0 && item < discCount) d = item;
            if (d === null) continue;
            if (mode === 0) disc.on(d);
            else if (mode === 1) disc.off(d);
            else disc.toggle(d);
          }
        };
        applyArray(member(action, 'on'), 0);
        applyArray(member(action, 'off'), 1);
        applyArray(member(action, 'toggle'), 2);
        return true;
      }
      if (equalsIgnoreCase(kind, 'icon.set')) {
        if (isTrue(member(action, 'allOn'), false)) icons.setAll();
        if (isTrue(member(action, 'allOff'), false)) icons.clearAll();
        const iconCount = classConst('IconService', 'kIconCount', ICON_COUNT);
        const applyArray = (node, mode) => {
          if (!isArr(node)) return;
          for (const item of node) {
            let ic = null;
            if (isStr(item)) ic = parseIconByName(item);
            else if (isInt(item) && item >= 0 && item < iconCount) ic = item;
            if (ic === null) continue;
            if (mode === 0) icons.on(ic);
            else if (mode === 1) icons.off(ic);
            else icons.toggle(ic);
          }
        };
        applyArray(member(action, 'on'), 0);
        applyArray(member(action, 'off'), 1);
        applyArray(member(action, 'toggle'), 2);
        return true;
      }
      if (equalsIgnoreCase(kind, 'topbar.set')) {
        let p = enumValue('TopBar', 'SPREAD');
        const patternNode = getField(action, 'pattern', 'p');
        if (isStr(patternNode)) {
          const parsed = parseTopBarPattern(patternNode);
          if (parsed !== null) p = parsed;
        } else if (isInt(patternNode)) {
          p = patternNode & 0xFF; // static_cast<Pattern : uint8_t>, unchecked (out-of-range values pass through)
        }
        topBar.setPattern(p);
        topBar.setAnimationEnabled(isTrue(getField(action, 'enabled', 'e'), true));
        topBar.setAnimationPeriod(asU32(getField(action, 'periodMs', 'pm'), kSeqDefaultTopBarPeriodMs));
        topBar.setAnimationReverse(isTrue(getField(action, 'reverse', 'rv'), false));
        if (topBar.setAnimationMirror) topBar.setAnimationMirror(isTrue(getField(action, 'mirror', 'mi'), false));
        return true;
      }
      if (equalsIgnoreCase(kind, 'track.anim')) {
        let anim = 'COUNT_UP';
        const nameNode = getField(action, 'name', 'n');
        if (isStr(nameNode)) {
          const parsed = parseTrackAnimation(nameNode);
          if (parsed === null) {
            this.lastError_ = 'track.anim requires valid name';
            return false;
          }
          anim = parsed;
        }
        const stepMs = asU32(getField(action, 'stepMs', 'ms'), kSeqDefaultTrackAnimStepMs);
        switch (anim) {
          case 'COUNT_UP': track.startCountUp(stepMs); break;
          case 'FILL_UP': track.startFillUp(stepMs); break;
          case 'COUNT_DOWN': track.startCountDown(stepMs); break;
          case 'FILLED_DOWN': track.startFilledDown(stepMs); break;
          case 'COUNT_DOWN_WARNING': track.startCountDownWarning(stepMs); break;
          case 'RANDOM_TOGGLE': track.startRandomToggle(stepMs, isTrue(getField(action, 'clearOnStart', 'cs'), true)); break;
          case 'NOTIF_COUNT': track.startNotifCount(stepMs); break; // host keeps the count live
          default: track.stopAnimation(); break;
        }
        return true;
      }
      if (equalsIgnoreCase(kind, 'track.numbers')) {
        if (isTrue(member(action, 'allOn'), false)) track.onAll();
        if (isTrue(member(action, 'allOff'), false)) track.offAll();
        const trackCount = classConst('TrackService', 'kTrackCount', 20);
        const applyList = (key, fn) => {
          const arr = member(action, key);
          if (!isArr(arr)) return;
          for (const item of arr) {
            const n = asU8(item, 0);
            if (n >= 1 && n <= trackCount) track[fn](n);
          }
        };
        applyList('on', 'on');
        applyList('off', 'off');
        applyList('toggle', 'toggle');
        return true;
      }
      if (equalsIgnoreCase(kind, 'track.swirl')) {
        const blink = isTrue(getField(action, 'blink', 'bl'), false);
        if (blink) {
          track.startSwirlBlink(asU32(getField(action, 'periodMs', 'pm'), kSeqDefaultTrackSwirlPeriodMs));
        } else {
          track.stopSwirlBlink();
          track.setSwirl(isTrue(getField(action, 'on', 'o'), true));
        }
        return true;
      }
      if (equalsIgnoreCase(kind, 'counter.start')) {
        const C = 'NumberCounterService';
        this.stopClock_();
        const hasStart = hasField(action, 'start', 'st');
        const startValue = hasStart ? asFloat(getField(action, 'start', 'st'), 0.0)
          : counter.getCurrentValue();
        counter.start(startValue,
          asU8(getField(action, 'digits', 'dg'), classConst(C, 'kDefaultDigits', 4)),
          asU8(getField(action, 'decimals', 'dc'), classConst(C, 'kDefaultDecimals', 0)),
          asU32(getField(action, 'stepMs', 'ms'), kSeqDefaultCounterStepMs),
          isTrue(getField(action, 'increment', 'inc'), classConst(C, 'kDefaultIncrement', true)),
          asFloat(getField(action, 'stepValue', 'sv'), classConst(C, 'kDefaultStepSize', 1.0)),
          asU8(getField(action, 'font', 'f'), classConst(C, 'kDefaultFontIndex', 0)));
        counter.setRollFrameInterval(asU32(getField(action, 'rollFrameMs', 'rm'), kSeqDefaultCounterRollFrameMs));
        counter.setBlankRowsBetweenDigits(asU8(getField(action, 'blankRows', 'br'), kSeqDefaultCounterBlankRows));
        counter.setBlankPadding(asU8(getField(action, 'blankPadding', 'bp'), classConst(C, 'kDefaultBlankPadding', 0)));
        return true;
      }
      if (equalsIgnoreCase(kind, 'counter.stop')) {
        counter.stop();
        return true;
      }

      if (equalsIgnoreCase(kind, 'clock.show')) {
        const clock = this.clockService_;
        if (!clock) { this.lastError_ = 'clock.show: no clock service'; return false; }
        text.stop();
        this.textAnimationArmed_ = false;
        counter.stop();
        const CS = NS.ClockService || {};
        clock.start(isTrue(getField(action, 'h24', 'h'), true),
          asU32(getField(action, 'rollFrameMs', 'rm'), CS.kDefaultRollFrameMs || 30),
          asU8(getField(action, 'font', 'f'), CS.kDefaultFontIndex || 0),
          asU8(getField(action, 'blankRows', 'br'), CS.kDefaultBlankRows === undefined ? 1 : CS.kDefaultBlankRows),
          isTrue(getField(action, 'icon', 'ic'), true));
        return true;
      }
      if (equalsIgnoreCase(kind, 'clock.stop')) {
        this.stopClock_();
        return true;
      }

      this.lastError_ = 'unknown action kind: ' + kind;
      return false;
    }
  }

  SequenceEngine.SequenceTag = SequenceTag;
  SequenceEngine.EndReason = EndReason;
  SequenceEngine.INPUTS = INPUTS;
  SequenceEngine.kDocCapacity = kDocCapacity;
  SequenceEngine.kMaxSteps = kMaxSteps;
  NS.SequenceEngine = SequenceEngine;
})(typeof window !== 'undefined' ? window : globalThis);
