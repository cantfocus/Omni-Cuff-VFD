// SVG replica of the BJ609GK fluorescent display (NSX-909 front panel tube).
// Every segment is tagged with its grid (1..13) and anode pin P1..P36 taken from
// the "FL GRID ASSIGNMENT & ANODE CONNECTION" sheet (docs/BJ609GK-grid-anode-map.jpg).
// render(vfd) lights a segment when bit (P-1) of that grid is set in base|overlay.
(function (G) {
  'use strict';
  const NS = G.VFDSim = G.VFDSim || {};
  const SVGNS = 'http://www.w3.org/2000/svg';

  const W = 1140, H = 318;

  // Left/right gutter wings are mirror images about x = MIRROR_X / 2.
  const MIRROR_X = 1150;
  // Left (BBE) gutter wing: one entry per segment (B73, B74, B75), each with
  // three "\_" chevrons; w = stroke width (each segment is drawn a bit larger).
  const GUTTER = [
    { w: 4, lines: [
      [[150.4, 197.8], [161.6, 205.9], [177.3, 205.9]],
      [[143.9, 205.2], [155.6, 214.4], [173.6, 214.3]],
      [[137.2, 214.0], [149.9, 223.3], [169.5, 223.0]]] },
    { w: 4.63, lines: [
      [[130.8, 225.3], [143.8, 234.7], [161.9, 234.7]],
      [[124.6, 234.4], [138.4, 243.9], [159.2, 243.7]],
      [[118.5, 242.2], [133.1, 252.9], [155.8, 252.6]]] },
    { w: 5.76, lines: [
      [[110.3, 253.1], [126.4, 264.8], [149.0, 264.8]],
      [[102.0, 262.6], [119.6, 275.3], [145.5, 275.1]],
      [[94.9, 271.5], [113.2, 284.9], [141.4, 284.5]]] },
  ];

  // Segments whose phosphor isn't the default green (EQ bars are coloured by row in _buildBars).
  const SEG_COLOR = {
    blue: ['1:33', '1:24', '1:16', '1:25', '1:26', '1:27', '1:28', '1:29', '1:30', '13:16', '2:4', '4:29'],
    yellow: ['1:11', '1:7', '1:8', '1:9', '1:10', '13:1', '13:2', '2:11', '2:12', '2:20', '4:25'],
    orange: ['1:5', '2:10', '2:15', '2:16', '4:5', '4:1', '4:9'], // 2:10 = REC_ICN box, 4:1 = REC
  };

  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  class Display {
    constructor(container) {
      this.byGrid = Array.from({ length: 14 }, () => Array.from({ length: 36 }, () => []));
      this.lastBits = new Array(14).fill(-1n);
      this.svg = el('svg', {
        viewBox: `0 0 ${W} ${H}`, class: 'vfd-svg', role: 'img',
        'aria-label': 'Simulated VFD display',
      });
      const defs = el('defs', {}, this.svg);
      const f = el('filter', { id: 'vfd-glow', x: '-20%', y: '-20%', width: '140%', height: '140%' }, defs);
      el('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '2.4', result: 'b' }, f);
      const m = el('feMerge', {}, f);
      el('feMergeNode', { in: 'b' }, m);
      el('feMergeNode', { in: 'SourceGraphic' }, m);

      this.frames = el('g', { class: 'vfd-frame' }, this.svg);
      this.layer = el('g', { filter: 'url(#vfd-glow)' }, this.svg);
      this._build();
      container.appendChild(this.svg);
    }

    // Register an element (or group) as segment (grid, P#).
    _seg(grid, pin, node, label) {
      node.classList.add('seg');
      const t = el('title', {}, node);
      t.textContent = `${label} — G${grid} P${pin}`;
      this.byGrid[grid][pin - 1].push(node);
      return node;
    }
    _group(grid, pin, label) {
      return this._seg(grid, pin, el('g', {}, this.layer), label);
    }
    _rect(grid, pin, x, y, w, h, label, rx = 1.5) {
      return this._seg(grid, pin, el('rect', { x, y, width: w, height: h, rx }, this.layer), label);
    }
    _text(grid, pin, x, y, str, label, size = 13, extra = {}) {
      const t = el('text', Object.assign({ x, y, 'font-size': size, class: 'seg-txt' }, extra), this.layer);
      t.textContent = str;
      return this._seg(grid, pin, t, label || str);
    }
    _stroke(grid, pin, d, label, width = 4) {
      return this._seg(grid, pin, el('path', { d, 'stroke-width': width, class: 'seg-line', fill: 'none' }, this.layer), label);
    }

    _build() {
      // Decorative bezel lines (not segments)
      const fr = (x, y, w, h) => el('rect', { x, y, width: w, height: h, rx: 3 }, this.frames);
      fr(2, 2, 262, 160); fr(268, 2, 868, 182);
      // Lower frames (grids 2 / 3 / 4) split by slanted dividers that follow the EQ column lean
      const poly = (pts) => el('path', { d: 'M' + pts.map((p) => p.join(' ')).join(' L') + ' Z', 'stroke-linejoin': 'round' }, this.frames);
      poly([[2, 166], [266, 166], [266, 188], [313.8, 188], [246.5, 314], [2, 314]]);
      poly([[317.8, 188], [653.6, 188], [661.6, 314], [250.5, 314]]);
      poly([[657.6, 188], [1136, 188], [1136, 314], [665.6, 314]]);

      this._buildGrid1();
      this._buildText();
      this._buildGrid13();
      this._buildGrid2();
      this._buildBars();
      this._buildGrid4Icons();

      for (const color in SEG_COLOR) for (const key of SEG_COLOR[color]) {
        const [g, p] = key.split(':').map(Number);
        for (const n of this.byGrid[g][p - 1]) n.classList.add('c-' + color);
      }
    }

    // ── Grid 1: discs, pinwheel, swoosh, digit, tuner icons ─────────────
    _buildGrid1() {
      const circ = (pin, cx, cy, r, label, w = 3.5) => this._seg(1, pin,
        el('circle', { cx, cy, r, 'stroke-width': w, class: 'seg-line', fill: 'none' }, this.layer), label);
      const dot = (pin, cx, cy, r, label) => this._seg(1, pin, el('circle', { cx, cy, r }, this.layer), label);
      const spokes = (pin, cx, cy, r0, r1, n, off, label) => {
        const g = this._group(1, pin, label);
        for (let i = 0; i < n; i++) {
          const a = (off + i * 360 / n) * Math.PI / 180;
          el('line', {
            x1: cx + r0 * Math.cos(a), y1: cy + r0 * Math.sin(a),
            x2: cx + r1 * Math.cos(a), y2: cy + r1 * Math.sin(a),
            'stroke-width': 4, 'stroke-linecap': 'round', class: 'seg-line',
          }, g);
        }
      };

      // Disc 2 (large, left): S2 edge P31, S20 hub P33, S21 wheel P32
      circ(31, 72, 92, 46, 'Disc2 edge S2');
      dot(33, 72, 92, 7, 'Disc2 hub S20');
      spokes(32, 72, 92, 14, 36, 8, 0, 'Disc2 wheel S21');
      // Disc 3 (right): S3 edge P22, S22 hub P24, S23 wheel P23
      circ(22, 160, 104, 31, 'Disc3 edge S3');
      dot(24, 160, 104, 6, 'Disc3 hub S22');
      spokes(23, 160, 104, 11, 24, 6, 15, 'Disc3 wheel S23');
      // Disc 1 (top): S1 edge P11, S10 hub P16, pinwheel S11..S19
      circ(11, 134, 38, 32, 'Disc1 edge S1');
      dot(16, 134, 38, 6, 'Disc1 hub S10');
      const pinwheel = [[12, 'S11'], [13, 'S12'], [15, 'S13'], [18, 'S14'], [20, 'S15'],
                        [21, 'S16'], [19, 'S17'], [17, 'S18'], [14, 'S19']];
      pinwheel.forEach(([pin, name], i) => {
        const a = (-90 + i * 40) * Math.PI / 180;
        const cx = 134, cy = 38;
        this._stroke(1, pin,
          `M${cx + 11 * Math.cos(a)} ${cy + 11 * Math.sin(a)} L${cx + 25 * Math.cos(a)} ${cy + 25 * Math.sin(a)}`,
          `Pinwheel ${name}`, 5);
      });
      // Swoosh S4..S9 along an arc under the discs
      const sw = [[30, 'S4'], [29, 'S5'], [28, 'S6'], [27, 'S7'], [26, 'S8'], [25, 'S9']];
      const ecx = 112, ecy = 96, rx = 98, ry = 58;
      sw.forEach(([pin, name], i) => {
        const a0 = (158 - i * 22) * Math.PI / 180, a1 = (158 - i * 22 - 17) * Math.PI / 180;
        const p = (a) => `${ecx + rx * Math.cos(a)} ${ecy + ry * Math.sin(a)}`;
        this._stroke(1, pin, `M${p(a0)} A${rx} ${ry} 0 0 0 ${p(a1)}`, `Swoosh ${name}`, 5);
      });

      // Partial 7-seg digit (no f segment): b P7, c P8, a/d/g P9, e P10
      const dx = 192, dy = 10, dw = 16, dh = 22, t = 3.2;
      this._rect(1, 7, dx + dw, dy + 2, t, dh - 3, 'Digit b');
      this._rect(1, 8, dx + dw, dy + dh + 2, t, dh - 3, 'Digit c');
      const adg = this._group(1, 9, 'Digit a/d/g');
      for (const yy of [dy, dy + dh, dy + 2 * dh]) el('rect', { x: dx + 2, y: yy, width: dw - 3, height: t, rx: 1 }, adg);
      this._rect(1, 10, dx - 1, dy + dh + 2, t, dh - 3, 'Digit e');

      this._text(1, 6, 222, 22, 'RDS', 'RDS', 13);
      this._text(1, 2, 226, 40, 'AG', 'AG', 13);
      this._text(1, 1, 222, 58, 'EON', 'EON', 13);
      this._seg(1, 3, el('circle', { cx: 236, cy: 76, r: 3.2 }, this.layer), 'Dot');
      this._text(1, 4, 212, 108, 'MONO', 'MONO', 13);
      this._text(1, 5, 210, 132, '((ꝏ))', 'Stereo', 14);
    }

    // ── Grids 5..12: 8 x 5x7 dot-matrix text cells ──────────────────────
    _buildText() {
      const x0 = 276, pitch = 78.5, dot = 8.4, step = 10.6, top = 70;
      for (let c = 0; c < 8; c++) {
        const grid = 5 + c;
        const cx = x0 + c * pitch;
        el('rect', { x: cx - 6, y: top - 7, width: 66, height: 88, rx: 3 }, this.frames);
        for (let n = 1; n <= 35; n++) {
          const col = (n - 1) % 5, row = Math.floor((n - 1) / 5);
          this._rect(grid, n, cx + col * step + 2, top + row * step + 1, dot, dot,
            `Char ${c + 1} col ${col + 1} row ${row + 1}`, 1);
        }
      }
    }

    // ── Grid 13: top bar, labels, tracks, swirl ─────────────────────────
    _buildGrid13() {
      // Top bar B1..B7 = P9..P3
      const x0 = 284, segW = 84, gap = 6, y = 16;
      for (let i = 0; i < 7; i++) {
        const pin = 9 - i;
        const xs = x0 + i * (segW + gap), xe = xs + segW;
        let d = `M${xs} ${y} L${xe} ${y}`;
        if (i === 0) d = `M${xs - 6} ${y + 14} Q${xs - 6} ${y} ${xs + 8} ${y} L${xe} ${y}`;
        if (i === 6) d = `M${xs} ${y} L${xe - 8} ${y} Q${xe + 6} ${y} ${xe + 6} ${y + 14}`;
        this._stroke(13, pin, d, `Top bar B${i + 1}`, 3.5);
      }
      this._text(13, 2, 300, 50, 'GRAPHIC EQUALIZER', 'GRAPHIC EQUALIZER', 18, { 'letter-spacing': 1.5 });
      this._text(13, 1, 708, 50, 'DSP SURROUND', 'DSP SURROUND', 18, { 'letter-spacing': 1.5 });

      this._text(13, 10, 926, 30, 'RANDOM', 'RANDOM', 13);
      this._text(13, 11, 932, 47, 'PRGM', 'PRGM', 13);
      this._text(13, 12, 936, 64, 'EDIT', 'EDIT', 13);
      this._stroke(13, 13, 'M968 78 L932 78 Q924 78 924 86 Q924 94 932 94 L964 94 M956 89 L966 94 L956 99',
        'Repeat', 3);
      this._text(13, 14, 932, 132, 'KHz', 'KHz', 13);
      this._text(13, 15, 932, 150, 'MHz', 'MHz', 13);

      // Track numbers 1..20 (4 rows of 5)
      const trackPin = [20, 24, 28, 32, 35, 19, 23, 27, 31, 36, 18, 22, 26, 30, 34, 17, 21, 25, 29, 33];
      const tx0 = 990, tPitch = 25, rows = [32, 70, 108, 146];
      for (let n = 1; n <= 20; n++) {
        const r = Math.floor((n - 1) / 5), c = (n - 1) % 5;
        const g = this._group(13, trackPin[n - 1], `Track ${n}`);
        const x = tx0 + c * tPitch, yy = rows[r];
        el('rect', { x, y: yy - 13, width: 20, height: 18, rx: 2, fill: 'none', 'stroke-width': 1.6, class: 'seg-line' }, g);
        const t = el('text', { x: x + 10, y: yy + 1, 'font-size': n > 9 ? 11 : 13, 'text-anchor': 'middle', class: 'seg-txt' }, g);
        t.textContent = String(n);
      }
      // Swirl S26 (P16): loops around each track row
      const sg = this._group(13, 16, 'Track swirl S26');
      for (const yy of rows) {
        el('path', {
          d: `M${tx0 - 10} ${yy + 10} L${tx0 + 118} ${yy + 10} Q${tx0 + 134} ${yy + 10} ${tx0 + 134} ${yy - 4} ` +
             `Q${tx0 + 134} ${yy - 17} ${tx0 + 114} ${yy - 17}`,
          fill: 'none', 'stroke-width': 2.4, class: 'seg-line',
        }, sg);
      }
    }

    // ── Grid 2: transport/tape icons, BBE wing, S24 gutter, bar column 1 ─
    _buildGrid2() {
      const bp = this._group(2, 15, '(♭) brackets');
      for (const [x, s] of [[6, '('], [24, ')']]) { const t = el('text', { x, y: 186, 'font-size': 14, class: 'seg-txt' }, bp); t.textContent = s; }
      const sp = this._group(2, 16, '(♯) brackets');
      for (const [x, s] of [[34, '('], [52, ')']]) { const t = el('text', { x, y: 186, 'font-size': 14, class: 'seg-txt' }, sp); t.textContent = s; }
      const fs = this._group(2, 14, '♭ ♯');
      for (const [x, s] of [[13, '♭'], [41, '♯']]) { const t = el('text', { x, y: 186, 'font-size': 14, class: 'seg-txt' }, fs); t.textContent = s; }
      this._text(2, 23, 66, 186, 'AUTO', 'AUTO', 14);
      const mic = this._group(2, 22, 'Mic VF');
      el('circle', { cx: 126, cy: 176, r: 5, fill: 'none', 'stroke-width': 2, class: 'seg-line' }, mic);
      el('path', { d: 'M122 180 L110 196', 'stroke-width': 3, class: 'seg-line', 'stroke-linecap': 'round' }, mic);
      const vf = el('text', { x: 134, y: 180, 'font-size': 12, class: 'seg-txt' }, mic); vf.textContent = 'VF';

      const dd = this._group(2, 2, 'DD NR');
      el('rect', { x: 5, y: 199, width: 22, height: 15, rx: 1.5, fill: 'none', 'stroke-width': 1.6, class: 'seg-line' }, dd);
      const ddt = el('text', { x: 7, y: 211, 'font-size': 12, class: 'seg-txt' }, dd); ddt.textContent = 'DD';
      const nr = el('text', { x: 30, y: 212, 'font-size': 13, class: 'seg-txt' }, dd); nr.textContent = 'NR';
      const rec = this._group(2, 10, 'REC (box)');
      el('rect', { x: 54, y: 199, width: 36, height: 15, rx: 1.5, fill: 'none', 'stroke-width': 1.6, class: 'seg-line' }, rec);
      const rt = el('text', { x: 57, y: 211, 'font-size': 12, class: 'seg-txt' }, rec); rt.textContent = 'REC';

      this._seg(2, 11, el('path', { d: 'M28 228 L12 236 L28 244 Z' }, this.layer), '◁');
      this._seg(2, 12, el('path', { d: 'M36 228 L52 236 L36 244 Z' }, this.layer), '▷');

      this._text(2, 6, 12, 274, '(', 'Reverse (', 20);
      this._stroke(2, 7, 'M22 258 L36 258 L22 274 L36 274 M29 254 L29 262', 'Reverse Z', 2.6);
      this._text(2, 8, 40, 274, ')', 'Reverse )', 20);
      this._text(2, 3, 98, 302, 'BBE', 'BBE', 15);

      // BBE wing (EQ gutter): B73 P20, B74 P19, B75 P18
      this._gutter(2, [20, 19, 18], ['B73', 'B74', 'B75'], false);
      // S24 (P4): dashed column, tilted to follow the wing
      const s24 = this._group(2, 4, 'Gutter S24');
      s24.setAttribute('transform', 'rotate(13.6 185.34 215.44)');
      for (let i = 0; i < 8; i++) el('rect', { x: 181, y: 204 + i * 12, width: 10, height: 8, rx: 1 }, s24);
    }

    // Gutter wing: 3 segments, each a group of 3 chevrons ("\_" strokes) that
    // grow toward the bottom. Drawn for the left (BBE) side; the right (T-BASS)
    // side is the mirror image about x = MIRROR_X.
    _gutter(grid, pins, names, mirror) {
      const mx = (x) => (mirror ? MIRROR_X - x : x);
      GUTTER.forEach((seg, i) => {
        const g = this._group(grid, pins[i], `Gutter ${names[i]}`);
        for (const pts of seg.lines) {
          el('path', {
            d: 'M' + pts.map(([x, y]) => `${mx(x)} ${y}`).join(' L'),
            'stroke-width': seg.w, class: 'seg-line', fill: 'none',
          }, g);
        }
      });
    }

    // ── EQ bars B1..B72 across grids 2/3/4 (same LUT as eqService.h) ────
    _buildBars() {
      // Bar positions traced from the datasheet's EQ detail drawing: every column
      // leans away from the tube centre and rows get taller/further apart toward
      // the bottom (perspective). [x, y] of each bar, top row first.
      const cols = [
        { grid: 2, top: 32, xy: [[228.9, 204.0], [226.4, 210.4], [220.5, 217.6], [215.5, 225.6], [210.5, 232.8], [202.9, 243.2], [196.2, 253.6], [187.0, 267.2], [182.0, 284.0]] },
        { grid: 3, top: 35, xy: [[321.0, 204.0], [318.5, 210.4], [314.3, 218.4], [310.9, 226.4], [306.7, 233.6], [302.6, 244.8], [298.4, 256.0], [291.7, 269.6], [286.6, 288.0]] },
        { grid: 3, top: 34, xy: [[408.0, 204.0], [406.4, 210.4], [404.7, 218.4], [401.3, 227.2], [398.0, 236.0], [394.6, 247.2], [392.1, 258.4], [389.6, 272.8], [387.9, 289.6]] },
        { grid: 3, top: 33, xy: [[495.1, 204.0], [494.3, 210.4], [492.6, 218.4], [490.9, 227.2], [488.4, 236.0], [486.7, 247.2], [484.2, 258.4], [481.7, 272.8], [480.9, 290.4]] },
        { grid: 3, top: 32, xy: [[578.8, 204.0], [578.8, 210.4], [578.8, 218.4], [579.7, 227.2], [579.7, 236.0], [580.5, 247.2], [580.5, 258.4], [581.3, 272.8], [581.3, 289.6]] },
        { grid: 4, top: 35, xy: [[674.2, 204.0], [675.1, 210.4], [675.1, 218.4], [675.9, 227.2], [676.8, 236.0], [678.4, 247.2], [679.3, 258.4], [680.9, 272.8], [681.8, 290.4]] },
        { grid: 4, top: 34, xy: [[758.0, 204.0], [759.6, 210.4], [762.2, 218.4], [766.3, 226.4], [769.7, 234.4], [774.7, 245.6], [779.7, 256.0], [785.6, 270.4], [788.9, 290.4]] },
        { grid: 4, top: 33, xy: [[840.0, 204.0], [843.4, 210.4], [848.4, 217.6], [854.2, 225.6], [859.3, 232.8], [866.8, 243.2], [874.3, 254.4], [882.7, 267.2], [887.7, 287.2]] },
      ];
      const BAR_W = 61.1;
      // Traced row height (slot) vs drawn bar height: bars are centred in their
      // slot and drawn shorter so neighbouring rows don't run together.
      const ROW_SLOT = [4.8, 4.8, 4.8, 4.8, 7.2, 7.2, 8.0, 10.4, 10.4];
      const ROW_H = [3.0, 3.2, 3.4, 3.6, 5.2, 5.4, 6.0, 8.0, 8.4];
      // Top 4 rows yellow, middle 4 green, bottom row blue
      let b = 1;
      cols.forEach((c) => {
        c.xy.forEach(([x, y], r) => {
          const bit = c.top - 4 * r;
          const bar = this._rect(c.grid, bit + 1, x, y + (ROW_SLOT[r] - ROW_H[r]) / 2, BAR_W, ROW_H[r], `EQ bar B${b++}`, 1);
          if (r < 4) bar.classList.add('c-yellow');
          else if (r === 8) bar.classList.add('c-blue');
        });
      });
    }

    // ── Grid 4 icons + right gutter ─────────────────────────────────────
    _buildGrid4Icons() {
      // Mirror of the left gutter: S25 dashes + T-BASS wing B76 P25, B77 P21, B78 P17
      const s25 = this._group(4, 29, 'Gutter S25');
      s25.setAttribute('transform', `rotate(-13.6 ${MIRROR_X - 185.34} 215.44)`);
      for (let i = 0; i < 8; i++) el('rect', { x: MIRROR_X - 191, y: 204 + i * 12, width: 10, height: 8, rx: 1 }, s25);
      this._gutter(4, [25, 21, 17], ['B76', 'B77', 'B78'], true);
      const clk = this._group(4, 5, 'Clock');
      el('circle', { cx: 1066, cy: 222, r: 9, fill: 'none', 'stroke-width': 2, class: 'seg-line' }, clk);
      el('path', { d: 'M1066 215 L1066 222 L1061 226', fill: 'none', 'stroke-width': 2, class: 'seg-line' }, clk);
      this._text(4, 1, 1082, 228, 'REC', 'REC', 15);
      this._text(4, 9, 1066, 252, 'SLEEP', 'SLEEP', 15);
      this._text(4, 13, 1050, 302, 'T-BASS', 'T-BASS', 15);
    }

    // Light segments from a VfdDriver (uses litBits = base|overlay, 0 when powered off)
    render(vfd) {
      for (let g = 1; g <= 13; g++) {
        const bits = vfd.litBits(g);
        if (bits === this.lastBits[g]) continue;
        const prev = this.lastBits[g] < 0n ? ~bits : this.lastBits[g];
        const diff = (bits ^ prev) & NS.MASK36;
        for (let p = 0; p < 36; p++) {
          if (!((diff >> BigInt(p)) & 1n)) continue;
          const on = ((bits >> BigInt(p)) & 1n) === 1n;
          for (const node of this.byGrid[g][p]) node.classList.toggle('on', on);
        }
        this.lastBits[g] = bits;
      }
    }

    // Light every mapped segment (useful for checking the layout)
    renderAll(on) {
      for (let g = 1; g <= 13; g++) for (const list of this.byGrid[g]) for (const n of list) n.classList.toggle('on', on);
      this.lastBits.fill(-1n);
    }
  }

  NS.Display = Display;
  NS.DISPLAY_CSS = `
    .vfd-svg { width: 100%; height: auto; display: block; background: #04100e;
               border-radius: 6px; box-shadow: inset 0 0 24px rgba(0,0,0,.8); }
    .vfd-svg .vfd-frame > * { fill: none; stroke: #10302a; stroke-width: 1; }
    /* Fill and stroke both follow one 'color' value, so a segment's fill and
       outline always switch together (instantly, like the real tube). */
    .vfd-svg .seg { --on: #7dffe0; --off: #0f2722;
                    color: var(--off); fill: currentColor; stroke: currentColor; }
    .vfd-svg .seg.c-blue   { --on: #4169e1; --off: #0f1a2e; }
    .vfd-svg .seg.c-yellow { --on: #ffc200; --off: #2a2410; }
    .vfd-svg .seg.c-orange { --on: #ff4e00; --off: #2a1810; }
    .vfd-svg .seg .seg-line, .vfd-svg .seg-line { fill: none; }
    .vfd-svg .seg rect:not(.seg-line), .vfd-svg .seg circle:not(.seg-line), .vfd-svg rect.seg, .vfd-svg circle.seg:not(.seg-line) { stroke: none; }
    .vfd-svg .seg-txt { stroke: none; font-family: 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif; font-weight: 700; }
    .vfd-svg .seg.on { color: var(--on); }
    .vfd-svg .seg title { pointer-events: none; }
  `;
})(typeof window !== 'undefined' ? window : globalThis);
