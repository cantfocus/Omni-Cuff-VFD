// EqService port: src/eqService.h + src/eqService.cpp + src/animations/eq/*.h
// Drives the 8-column x 9-row spectrum bars and 8-segment gutter on grids 2..4.
//
// Porting notes:
//  - uint64 grid masks are BigInt; uint8/uint16/uint32 math is emulated where
//    the C++ relies on wraparound (millis deltas use `(a - b) >>> 0`).
//  - Overloaded C++ setPattern()/setGutterPattern() are folded into one JS
//    method each; see their comments for how arguments are disambiguated.
//  - Animation frame tables are copied verbatim from src/animations/eq/*.h
//    (only the headers eqService.h includes; FFT_Bounce_32 / FFT_Chaotic_32 are
//    not included by the firmware and are therefore omitted).
(function (G) {
  'use strict';
  const NS = G.VFDSim = G.VFDSim || {};

  // ── Animation data (src/animations/eq/*.h) ─────────────────────
  // Each frame is 10 bytes: 9 rows of bars (bars[0] = top) + 1 gutter byte
  // bars[row] bit0=leftmost col, bit7=rightmost col

  // src/animations/eq/Bell_Sweep.h
  const Bell_SweepFrameCount = 28;
  const Bell_SweepDisplayTime = 100; // milliseconds
  const Bell_Sweep = [
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x06, 0xFF, 0x00], // frame 0
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x1C, 0xFF, 0x00], // frame 1
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x9C, 0xFF, 0x00], // frame 2
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x98, 0xBC, 0xFF, 0x00], // frame 3
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x30, 0x70, 0xF8, 0xFE, 0x00], // frame 4
    [0x00, 0x00, 0x00, 0x00, 0x10, 0x38, 0x78, 0xFD, 0xFD, 0x00], // frame 5
    [0x00, 0x00, 0x00, 0x00, 0x10, 0x38, 0x78, 0xFD, 0xFD, 0x00], // frame 6
    [0x00, 0x00, 0x00, 0x00, 0x0C, 0x1C, 0x3C, 0x7E, 0x7F, 0x00], // frame 7
    [0x00, 0x00, 0x00, 0x08, 0x0C, 0x1C, 0x3C, 0x7E, 0x7F, 0x00], // frame 8
    [0x00, 0x08, 0x08, 0x18, 0x1C, 0x1C, 0x3C, 0x7E, 0x7F, 0x00], // frame 9
    [0x00, 0x04, 0x04, 0x0C, 0x0E, 0x0E, 0x1E, 0x3F, 0xBF, 0x00], // frame 10
    [0x00, 0x04, 0x04, 0x06, 0x06, 0x0E, 0x1F, 0x3F, 0xBF, 0x00], // frame 11
    [0x00, 0x06, 0x06, 0x06, 0x06, 0x0E, 0x9E, 0xBF, 0xBF, 0x00], // frame 12
    [0x04, 0x06, 0x06, 0x06, 0x0E, 0x0E, 0x8E, 0xBF, 0xBF, 0x00], // frame 13
    [0x04, 0x06, 0x06, 0x06, 0x0E, 0x0E, 0x2E, 0xAF, 0xFF, 0x00], // frame 14
    [0x04, 0x06, 0x06, 0x06, 0x0E, 0x0E, 0x2E, 0xAF, 0xFF, 0x00], // frame 15
    [0x04, 0x04, 0x04, 0x06, 0x0E, 0x2E, 0x2E, 0x7E, 0xFF, 0x00], // frame 16
    [0x00, 0x04, 0x0C, 0x0C, 0x0E, 0x0E, 0x4E, 0x7E, 0xFF, 0x00], // frame 17
    [0x00, 0x04, 0x04, 0x0C, 0x0E, 0x0E, 0x4E, 0x4F, 0xEF, 0x00], // frame 18
    [0x00, 0x04, 0x06, 0x0E, 0x0E, 0x0E, 0x4E, 0x4F, 0xEF, 0x00], // frame 19
    [0x02, 0x02, 0x06, 0x06, 0x06, 0x0F, 0x4F, 0x4F, 0xEF, 0x00], // frame 20
    [0x00, 0x00, 0x02, 0x06, 0x06, 0x4F, 0x4F, 0xEF, 0xEF, 0x00], // frame 21
    [0x00, 0x00, 0x01, 0x03, 0x03, 0x23, 0x23, 0x77, 0x77, 0x00], // frame 22
    [0x00, 0x00, 0x00, 0x00, 0x02, 0x03, 0x23, 0x77, 0xF7, 0x00], // frame 23
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x02, 0x67, 0xF7, 0x00], // frame 24
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x02, 0x27, 0x7F, 0x00], // frame 25
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x26, 0xFF, 0x00], // frame 26
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF, 0x00], // frame 27
  ];

  // src/animations/eq/Chevron_DN_1x4.h
  const Chevron_DN_1x4FrameCount = 5;
  const Chevron_DN_1x4DisplayTime = 200; // milliseconds
  const Chevron_DN_1x4 = [
    [0x81, 0x42, 0x24, 0x18, 0x00, 0x81, 0x42, 0x24, 0x18, 0x00], // frame 0
    [0x00, 0x81, 0x42, 0x24, 0x18, 0x00, 0x81, 0x42, 0x24, 0x00], // frame 1
    [0x18, 0x00, 0x81, 0x42, 0x24, 0x18, 0x00, 0x81, 0x42, 0x00], // frame 2
    [0x24, 0x18, 0x00, 0x81, 0x42, 0x24, 0x18, 0x00, 0x81, 0x00], // frame 3
    [0x42, 0x24, 0x18, 0x00, 0x81, 0x42, 0x24, 0x18, 0x00, 0x00], // frame 4
  ];

  // src/animations/eq/Chevron_DN_2x3.h
  const Chevron_DN_2x3FrameCount = 5;
  const Chevron_DN_2x3DisplayTime = 200; // milliseconds
  const Chevron_DN_2x3 = [
    [0x81, 0xC3, 0x66, 0x3C, 0x18, 0x81, 0xC3, 0x66, 0x3C, 0x00], // frame 0
    [0x18, 0x81, 0xC3, 0x66, 0x3C, 0x18, 0x81, 0xC3, 0x66, 0x00], // frame 1
    [0x3C, 0x18, 0x81, 0xC3, 0x66, 0x3C, 0x18, 0x81, 0xC3, 0x00], // frame 2
    [0x66, 0x3C, 0x18, 0x81, 0xC3, 0x66, 0x3C, 0x18, 0x81, 0x00], // frame 3
    [0xC3, 0x66, 0x3C, 0x18, 0x81, 0xC3, 0x66, 0x3C, 0x18, 0x00], // frame 4
  ];

  // src/animations/eq/Chevron_DN_2x3x1x3.h
  const Chevron_DN_2x3x1x3FrameCount = 9;
  const Chevron_DN_2x3x1x3DisplayTime = 200; // milliseconds
  const Chevron_DN_2x3x1x3 = [
    [0x81, 0x42, 0x24, 0x18, 0x81, 0xC3, 0x66, 0x3C, 0x18, 0x00], // frame 0
    [0x18, 0x81, 0x42, 0x24, 0x18, 0x81, 0xC3, 0x66, 0x3C, 0x00], // frame 1
    [0x3C, 0x18, 0x81, 0x42, 0x24, 0x18, 0x81, 0xC3, 0x66, 0x00], // frame 2
    [0x66, 0x3C, 0x18, 0x81, 0x42, 0x24, 0x18, 0x81, 0xC3, 0x00], // frame 3
    [0xC3, 0x66, 0x3C, 0x18, 0x81, 0x42, 0x24, 0x18, 0x81, 0x00], // frame 4
    [0x81, 0xC3, 0x66, 0x3C, 0x18, 0x81, 0x42, 0x24, 0x18, 0x00], // frame 5
    [0x18, 0x81, 0xC3, 0x66, 0x3C, 0x18, 0x81, 0x42, 0x24, 0x00], // frame 6
    [0x24, 0x18, 0x81, 0xC3, 0x66, 0x3C, 0x18, 0x81, 0x42, 0x00], // frame 7
    [0x42, 0x24, 0x18, 0x81, 0xC3, 0x66, 0x3C, 0x18, 0x81, 0x00], // frame 8
  ];

  // src/animations/eq/Chevron_DN_2x4.h
  const Chevron_DN_2x4FrameCount = 6;
  const Chevron_DN_2x4DisplayTime = 200; // milliseconds
  const Chevron_DN_2x4 = [
    [0x81, 0xC3, 0x66, 0x3C, 0x18, 0x00, 0x81, 0xC3, 0x66, 0x00], // frame 0
    [0x00, 0x81, 0xC3, 0x66, 0x3C, 0x18, 0x00, 0x81, 0xC3, 0x00], // frame 1
    [0x18, 0x00, 0x81, 0xC3, 0x66, 0x3C, 0x18, 0x00, 0x81, 0x00], // frame 2
    [0x3C, 0x18, 0x00, 0x81, 0xC3, 0x66, 0x3C, 0x18, 0x00, 0x00], // frame 3
    [0x66, 0x3C, 0x18, 0x00, 0x81, 0xC3, 0x66, 0x3C, 0x18, 0x00], // frame 4
    [0xC3, 0x66, 0x3C, 0x18, 0x00, 0x81, 0xC3, 0x66, 0x3C, 0x00], // frame 5
  ];

  // src/animations/eq/Chevron_DN_3x2x1x2x2.h
  const Chevron_DN_3x2x1x2x2FrameCount = 12;
  const Chevron_DN_3x2x1x2x2DisplayTime = 200; // milliseconds
  const Chevron_DN_3x2x1x2x2 = [
    [0x99, 0x42, 0x24, 0x99, 0xC3, 0xE7, 0x7E, 0x3C, 0x99, 0x00], // frame 0
    [0x3C, 0x99, 0x42, 0x24, 0x99, 0xC3, 0xE7, 0x7E, 0x3C, 0x00], // frame 1
    [0x66, 0x3C, 0x99, 0x42, 0x24, 0x99, 0xC3, 0xE7, 0x7E, 0x00], // frame 2
    [0xC3, 0x66, 0x3C, 0x99, 0x42, 0x24, 0x99, 0xC3, 0xE7, 0x00], // frame 3
    [0x99, 0xC3, 0x66, 0x3C, 0x99, 0x42, 0x24, 0x99, 0xC3, 0x00], // frame 4
    [0x3C, 0x99, 0xC3, 0x66, 0x3C, 0x99, 0x42, 0x24, 0x99, 0x00], // frame 5
    [0x7E, 0x3C, 0x99, 0xC3, 0x66, 0x3C, 0x99, 0x42, 0x24, 0x00], // frame 6
    [0xE7, 0x7E, 0x3C, 0x99, 0xC3, 0x66, 0x3C, 0x99, 0x42, 0x00], // frame 7
    [0xC3, 0xE7, 0x7E, 0x3C, 0x99, 0xC3, 0x66, 0x3C, 0x99, 0x00], // frame 8
    [0x99, 0xC3, 0xE7, 0x7E, 0x3C, 0x99, 0xC3, 0x66, 0x3C, 0x00], // frame 9
    [0x24, 0x99, 0xC3, 0xE7, 0x7E, 0x3C, 0x99, 0xC3, 0x66, 0x00], // frame 10
    [0x42, 0x24, 0x99, 0xC3, 0xE7, 0x7E, 0x3C, 0x99, 0xC3, 0x00], // frame 11
  ];

  // src/animations/eq/Chevron_DN_3x3x1x3.h
  const Chevron_DN_3x3x1x3FrameCount = 10;
  const Chevron_DN_3x3x1x3DisplayTime = 200; // milliseconds
  const Chevron_DN_3x3x1x3 = [
    [0x42, 0x24, 0x18, 0x81, 0xC3, 0xE7, 0x7E, 0x3C, 0x18, 0x00], // frame 0
    [0x81, 0x42, 0x24, 0x18, 0x81, 0xC3, 0xE7, 0x7E, 0x3C, 0x00], // frame 1
    [0x18, 0x81, 0x42, 0x24, 0x18, 0x81, 0xC3, 0xE7, 0x7E, 0x00], // frame 2
    [0x3C, 0x18, 0x81, 0x42, 0x24, 0x18, 0x81, 0xC3, 0xE7, 0x00], // frame 3
    [0x7E, 0x3C, 0x18, 0x81, 0x42, 0x24, 0x18, 0x81, 0xC3, 0x00], // frame 4
    [0xE7, 0x7E, 0x3C, 0x18, 0x81, 0x42, 0x24, 0x18, 0x81, 0x00], // frame 5
    [0xC3, 0xE7, 0x7E, 0x3C, 0x18, 0x81, 0x42, 0x24, 0x18, 0x00], // frame 6
    [0x81, 0xC3, 0xE7, 0x7E, 0x3C, 0x18, 0x81, 0x42, 0x24, 0x00], // frame 7
    [0x18, 0x81, 0xC3, 0xE7, 0x7E, 0x3C, 0x18, 0x81, 0x42, 0x00], // frame 8
    [0x24, 0x18, 0x81, 0xC3, 0xE7, 0x7E, 0x3C, 0x18, 0x81, 0x00], // frame 9
  ];

  // src/animations/eq/Chevron_UP_1x4.h
  const Chevron_UP_1x4FrameCount = 5;
  const Chevron_UP_1x4DisplayTime = 200; // milliseconds
  const Chevron_UP_1x4 = [
    [0x18, 0x24, 0x42, 0x81, 0x00, 0x18, 0x24, 0x42, 0x81, 0x00], // frame 0
    [0x24, 0x42, 0x81, 0x00, 0x18, 0x24, 0x42, 0x81, 0x00, 0x00], // frame 1
    [0x42, 0x81, 0x00, 0x18, 0x24, 0x42, 0x81, 0x00, 0x18, 0x00], // frame 2
    [0x81, 0x00, 0x18, 0x24, 0x42, 0x81, 0x00, 0x18, 0x24, 0x00], // frame 3
    [0x00, 0x18, 0x24, 0x42, 0x81, 0x00, 0x18, 0x24, 0x42, 0x00], // frame 4
  ];

  // src/animations/eq/Chevron_UP_2x3.h
  const Chevron_UP_2x3FrameCount = 5;
  const Chevron_UP_2x3DisplayTime = 200; // milliseconds
  const Chevron_UP_2x3 = [
    [0x18, 0x3C, 0x66, 0xC3, 0x81, 0x18, 0x3C, 0x66, 0xC3, 0x00], // frame 0
    [0x3C, 0x66, 0xC3, 0x81, 0x18, 0x3C, 0x66, 0xC3, 0x81, 0x00], // frame 1
    [0x66, 0xC3, 0x81, 0x18, 0x3C, 0x66, 0xC3, 0x81, 0x18, 0x00], // frame 2
    [0xC3, 0x81, 0x18, 0x3C, 0x66, 0xC3, 0x81, 0x18, 0x3C, 0x00], // frame 3
    [0x00, 0x18, 0x3C, 0x66, 0xC3, 0x81, 0x18, 0x3C, 0x66, 0x00], // frame 4
  ];

  // src/animations/eq/DataProcessing.h
  const DataProcessingFrameCount = 3;
  const DataProcessingDisplayTime = 75; // milliseconds
  const DataProcessing = [
    [0x92, 0x24, 0x49, 0x92, 0x24, 0x49, 0x92, 0x24, 0x49, 0x00], // frame 0
    [0x24, 0x49, 0x92, 0x24, 0x49, 0x92, 0x24, 0x49, 0x92, 0x00], // frame 1
    [0x49, 0x92, 0x24, 0x49, 0x92, 0x24, 0x49, 0x92, 0x24, 0x00], // frame 2
  ];

  // src/animations/eq/Right_Arrow_sweep.h
  const Right_Arrow_sweepFrameCount = 9;
  const Right_Arrow_sweepDisplayTime = 120; // milliseconds
  const Right_Arrow_sweep = [
    [0x01, 0x01, 0x03, 0x07, 0x0F, 0x07, 0x03, 0x01, 0x01, 0x00], // frame 0
    [0x02, 0x02, 0x06, 0x0E, 0x1E, 0x0E, 0x06, 0x02, 0x02, 0x00], // frame 1
    [0x04, 0x04, 0x0C, 0x1C, 0x3C, 0x1C, 0x0C, 0x04, 0x04, 0x00], // frame 2
    [0x08, 0x08, 0x18, 0x38, 0x78, 0x38, 0x18, 0x08, 0x08, 0x00], // frame 3
    [0x10, 0x10, 0x30, 0x70, 0xF0, 0x70, 0x30, 0x10, 0x10, 0x00], // frame 4
    [0x20, 0x20, 0x60, 0xE0, 0xE0, 0xE0, 0x60, 0x20, 0x20, 0x00], // frame 5
    [0x40, 0x40, 0xC0, 0xC0, 0xC0, 0xC0, 0xC0, 0x40, 0x40, 0x00], // frame 6
    [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00], // frame 7
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // frame 8
  ];

  // src/animations/eq/SinWave.h
  const SinWaveFrameCount = 18;
  const SinWaveDisplayTime = 100; // milliseconds
  const SinWave = [
    [0x30, 0x48, 0x85, 0x02, 0x05, 0x08, 0x10, 0x20, 0xC0, 0x00], // frame 0
    [0x60, 0x91, 0x0A, 0x04, 0x0A, 0x11, 0x20, 0x40, 0x80, 0x00], // frame 1
    [0xC1, 0x22, 0x14, 0x08, 0x14, 0x22, 0x41, 0x80, 0x00, 0x00], // frame 2
    [0x83, 0x44, 0x28, 0x10, 0x28, 0x44, 0x82, 0x01, 0x00, 0x00], // frame 3
    [0x06, 0x89, 0x50, 0x20, 0x50, 0x88, 0x04, 0x02, 0x01, 0x00], // frame 4
    [0x0C, 0x12, 0xA1, 0x40, 0xA0, 0x10, 0x08, 0x04, 0x03, 0x00], // frame 5
    [0x18, 0x24, 0x42, 0x81, 0x40, 0x20, 0x10, 0x09, 0x06, 0x00], // frame 6
    [0x30, 0x48, 0x84, 0x02, 0x81, 0x40, 0x21, 0x12, 0x0C, 0x00], // frame 7
    [0x60, 0x90, 0x08, 0x04, 0x02, 0x81, 0x42, 0x24, 0x18, 0x00], // frame 8
    [0xC0, 0x20, 0x10, 0x08, 0x05, 0x02, 0x85, 0x48, 0x30, 0x00], // frame 9
    [0x80, 0x40, 0x20, 0x11, 0x0A, 0x04, 0x0A, 0x91, 0x60, 0x00], // frame 10
    [0x00, 0x80, 0x41, 0x22, 0x14, 0x08, 0x14, 0x22, 0xC1, 0x00], // frame 11
    [0x00, 0x01, 0x82, 0x44, 0x28, 0x10, 0x28, 0x44, 0x83, 0x00], // frame 12
    [0x01, 0x02, 0x04, 0x88, 0x50, 0x20, 0x50, 0x89, 0x06, 0x00], // frame 13
    [0x03, 0x04, 0x08, 0x10, 0xA0, 0x40, 0xA1, 0x12, 0x0C, 0x00], // frame 14
    [0x06, 0x09, 0x10, 0x20, 0x40, 0x81, 0x42, 0x24, 0x18, 0x00], // frame 15
    [0x0C, 0x12, 0x21, 0x40, 0x81, 0x02, 0x84, 0x48, 0x30, 0x00], // frame 16
    [0x18, 0x24, 0x42, 0x81, 0x02, 0x04, 0x08, 0x90, 0x60, 0x00], // frame 17
  ];

  // src/animations/eq/TVStatic.h
  const TVStaticFrameCount = 20;
  const TVStaticDisplayTime = 70; // milliseconds
  const TVStatic = [
    [0x8E, 0x37, 0xC9, 0x0E, 0x04, 0xFE, 0x1E, 0x0D, 0x7C, 0x00], // frame 0
    [0x5F, 0x97, 0x4E, 0xA2, 0x0C, 0xE5, 0x2B, 0xC5, 0x2E, 0x00], // frame 1
    [0x27, 0xE9, 0x86, 0xB1, 0x18, 0xD3, 0x29, 0x31, 0x18, 0x00], // frame 2
    [0x39, 0x7B, 0xCE, 0x3D, 0x37, 0xD1, 0x84, 0x00, 0xA4, 0x00], // frame 3
    [0x28, 0xC2, 0xCE, 0x39, 0x34, 0x91, 0x55, 0xA2, 0x6D, 0x00], // frame 4
    [0xDA, 0xE0, 0xEC, 0xB5, 0xBC, 0x2D, 0x57, 0x88, 0xE6, 0x00], // frame 5
    [0xB1, 0x86, 0x08, 0xAB, 0x19, 0xB4, 0xA1, 0x00, 0x68, 0x00], // frame 6
    [0x72, 0x63, 0x3B, 0x3A, 0x10, 0xB0, 0x61, 0x96, 0x0E, 0x00], // frame 7
    [0xAF, 0xF7, 0xFD, 0x2E, 0xF8, 0x0A, 0xDE, 0x13, 0x2E, 0x00], // frame 8
    [0x74, 0xCF, 0xE9, 0xAD, 0x9C, 0xB2, 0xC7, 0x86, 0x3E, 0x00], // frame 9
    [0xF8, 0x66, 0x45, 0x85, 0xBD, 0xF6, 0x2F, 0x81, 0x3E, 0x00], // frame 10
    [0x78, 0x26, 0x39, 0x4D, 0xBB, 0x60, 0xA4, 0x6F, 0xAA, 0x00], // frame 11
    [0xF4, 0x72, 0x02, 0x17, 0xE1, 0x80, 0x86, 0x40, 0xA2, 0x00], // frame 12
    [0x1D, 0x5B, 0x9C, 0x83, 0xD6, 0x80, 0x6E, 0x68, 0xA0, 0x00], // frame 13
    [0xE6, 0x45, 0x52, 0x59, 0xCE, 0x04, 0x3E, 0x58, 0x83, 0x00], // frame 14
    [0x52, 0xA5, 0x36, 0x63, 0x67, 0x12, 0xCF, 0x93, 0xC1, 0x00], // frame 15
    [0x86, 0x13, 0xD6, 0x35, 0x6E, 0xD0, 0xC7, 0x0D, 0xA1, 0x00], // frame 16
    [0xC5, 0x04, 0x64, 0x23, 0xBF, 0xCF, 0xDF, 0x84, 0x38, 0x00], // frame 17
    [0x14, 0x02, 0x64, 0x32, 0x1F, 0xEF, 0xCF, 0x11, 0x68, 0x00], // frame 18
    [0x3E, 0x27, 0x44, 0x99, 0xFE, 0x64, 0xF4, 0x7D, 0xEA, 0x00], // frame 19
  ];

  // src/animations/eq/Vertical_Sinewave.h
  const vertical_sinewaveFrameCount = 16;
  const vertical_sinewaveDisplayTime = 200; // milliseconds
  const vertical_sinewave = [
    [0x82, 0x81, 0x41, 0x22, 0x14, 0x08, 0x14, 0x22, 0x41, 0x00], // frame 0
    [0x81, 0x41, 0x22, 0x14, 0x08, 0x14, 0x22, 0x41, 0x81, 0x00], // frame 1
    [0x41, 0x22, 0x14, 0x08, 0x14, 0x22, 0x41, 0x81, 0x82, 0x00], // frame 2
    [0x22, 0x14, 0x08, 0x14, 0x22, 0x41, 0x81, 0x82, 0x44, 0x00], // frame 3
    [0x14, 0x08, 0x14, 0x22, 0x41, 0x81, 0x82, 0x44, 0x28, 0x00], // frame 4
    [0x08, 0x14, 0x22, 0x41, 0x81, 0x82, 0x44, 0x28, 0x10, 0x00], // frame 5
    [0x14, 0x22, 0x41, 0x81, 0x82, 0x44, 0x28, 0x10, 0x28, 0x00], // frame 6
    [0x22, 0x41, 0x81, 0x82, 0x44, 0x28, 0x10, 0x28, 0x44, 0x00], // frame 7
    [0x41, 0x81, 0x82, 0x44, 0x28, 0x10, 0x28, 0x44, 0x82, 0x00], // frame 8
    [0x81, 0x82, 0x44, 0x28, 0x10, 0x28, 0x44, 0x82, 0x81, 0x00], // frame 9
    [0x82, 0x44, 0x28, 0x10, 0x28, 0x44, 0x82, 0x81, 0x41, 0x00], // frame 10
    [0x44, 0x28, 0x10, 0x28, 0x44, 0x82, 0x81, 0x41, 0x22, 0x00], // frame 11
    [0x28, 0x10, 0x28, 0x44, 0x82, 0x81, 0x41, 0x22, 0x14, 0x00], // frame 12
    [0x10, 0x28, 0x44, 0x82, 0x81, 0x41, 0x22, 0x14, 0x08, 0x00], // frame 13
    [0x28, 0x44, 0x82, 0x81, 0x41, 0x22, 0x14, 0x08, 0x14, 0x00], // frame 14
    [0x44, 0x82, 0x81, 0x41, 0x22, 0x14, 0x08, 0x14, 0x22, 0x00], // frame 15
  ];

  // src/animations/eq/Water_Fall_1x3.h
  const Water_Fall_1x3FrameCount = 4;
  const Water_Fall_1x3DisplayTime = 120; // milliseconds
  const Water_Fall_1x3 = [
    [0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00], // frame 0
    [0x00, 0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00, 0x00], // frame 1
    [0x00, 0x00, 0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00], // frame 2
    [0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00], // frame 3
  ];

  // src/animations/eq/Water_Fall_1x4.h
  const Water_Fall_1x4FrameCount = 5;
  const Water_Fall_1x4DisplayTime = 200; // milliseconds
  const Water_Fall_1x4 = [
    [0xFF, 0x00, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00, 0x00], // frame 0
    [0x00, 0xFF, 0x00, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00], // frame 1
    [0x00, 0x00, 0xFF, 0x00, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00], // frame 2
    [0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00, 0x00, 0xFF, 0x00], // frame 3
    [0x00, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00], // frame 4
  ];

  // src/animations/eq/Water_Fall_2x5.h
  const Water_Fall_2x5FrameCount = 13;
  const Water_Fall_2x5DisplayTime = 200; // milliseconds
  const Water_Fall_2x5 = [
    [0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // frame 0
    [0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // frame 1
    [0x00, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // frame 2
    [0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // frame 3
    [0x00, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00], // frame 4
    [0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00], // frame 5
    [0x00, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00, 0x00], // frame 6
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00], // frame 7
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0x00], // frame 8
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF, 0x00], // frame 9
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // frame 10
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // frame 11
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // frame 12
  ];

  // src/animations/eq/Waterfall_3x2.h
  const Waterfall_3x2FrameCount = 5;
  const Waterfall_3x2DisplayTime = 175; // milliseconds
  const Waterfall_3x2 = [
    [0xFF, 0xFF, 0xFF, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0x00, 0x00], // frame 0
    [0x00, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0x00], // frame 1
    [0x00, 0x00, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0xFF, 0xFF, 0x00], // frame 2
    [0xFF, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0xFF, 0x00], // frame 3
    [0xFF, 0xFF, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00], // frame 4
  ];

  // src/animations/eq/Waterfall_4x1.h
  const Waterfall_4x1FrameCount = 5;
  const Waterfall_4x1DisplayTime = 120; // milliseconds
  const Waterfall_4x1 = [
    [0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0x00], // frame 0
    [0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0xFF, 0xFF, 0xFF, 0x00], // frame 1
    [0xFF, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0xFF, 0xFF, 0x00], // frame 2
    [0xFF, 0xFF, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0xFF, 0x00], // frame 3
    [0xFF, 0xFF, 0xFF, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00], // frame 4
  ];

  // ── Enums (enum class, numeric values match declaration order) ─
  const Pattern = Object.freeze({
    PATTERN_OFF: 0,
    PATTERN_ON: 1,
    PATTERN_BLINK: 2,
    BELL_SWEEP: 3,
    CHEVRON_DN_1X4: 4,
    CHEVRON_DN_2X3: 5,
    CHEVRON_DN_2X3X1X3: 6,
    CHEVRON_DN_2X4: 7,
    CHEVRON_DN_3X2X1X2X2: 8,
    CHEVRON_DN_3X3X1X3: 9,
    CHEVRON_UP_1X4: 10,
    CHEVRON_UP_2X3: 11,
    DATA_PROCESSING: 12,
    RIGHT_ARROW_SWEEP: 13,
    SINWAVE: 14,
    TV_STATIC: 15,
    VERTICAL_SINEWAVE: 16,
    WATER_FALL_1X3: 17,
    WATER_FALL_1X4: 18,
    WATER_FALL_2X5: 19,
    WATERFALL_3X2: 20,
    WATERFALL_4X1: 21,
    MIC_LIVE: 22, // live microphone spectrum
    MIC_PEAK: 23, // live microphone spectrum with floating peak dots
  });

  const GutterPattern = Object.freeze({
    OFF: 0,
    ON: 1,
    BLINK: 2,
    CHASE: 3,
    DOUBLE_CHASE: 4,
  });

  const GutterSource = Object.freeze({
    FROM_BAR_PATTERN: 0,
    INDEPENDENT: 1,
  });

  const kFirstGrid = 2;
  const kLastGrid = 4;
  const kGridCount = 3;

  // Microphone spectrum timing (MIC_LIVE / MIC_PEAK).
  const kMicBarFallMs = 40;   // bar drops 1 row per this
  const kMicPeakHoldMs = 400; // peak dot hold time
  const kMicPeakFallMs = 80;  // peak dot drops 1 row per this

  // {grid, bit} where bit = anode bit (P-1)
  const gutterLut_ = Object.freeze([
    { grid: 2, bit: 19 }, // B73
    { grid: 2, bit: 18 }, // B74
    { grid: 2, bit: 17 }, // B75
    { grid: 2, bit: 3 },  // S24
    { grid: 4, bit: 28 }, // S25
    { grid: 4, bit: 24 }, // B76
    { grid: 4, bit: 20 }, // B77
    { grid: 4, bit: 16 }, // B78
  ]);

  const barLut = Object.freeze([
    { grid: 2, bit: 32 }, // B1
    { grid: 2, bit: 28 }, // B2
    { grid: 2, bit: 24 }, // B3
    { grid: 2, bit: 20 }, // B4
    { grid: 2, bit: 16 }, // B5
    { grid: 2, bit: 12 }, // B6
    { grid: 2, bit: 8 },  // B7
    { grid: 2, bit: 4 },  // B8
    { grid: 2, bit: 0 },  // B9

    { grid: 3, bit: 35 }, // B10
    { grid: 3, bit: 31 }, // B11
    { grid: 3, bit: 27 }, // B12
    { grid: 3, bit: 23 }, // B13
    { grid: 3, bit: 19 }, // B14
    { grid: 3, bit: 15 }, // B15
    { grid: 3, bit: 11 }, // B16
    { grid: 3, bit: 7 },  // B17
    { grid: 3, bit: 3 },  // B18

    { grid: 3, bit: 34 }, // B19
    { grid: 3, bit: 30 }, // B20
    { grid: 3, bit: 26 }, // B21
    { grid: 3, bit: 22 }, // B22
    { grid: 3, bit: 18 }, // B23
    { grid: 3, bit: 14 }, // B24
    { grid: 3, bit: 10 }, // B25
    { grid: 3, bit: 6 },  // B26
    { grid: 3, bit: 2 },  // B27

    { grid: 3, bit: 33 }, // B28
    { grid: 3, bit: 29 }, // B29
    { grid: 3, bit: 25 }, // B30
    { grid: 3, bit: 21 }, // B31
    { grid: 3, bit: 17 }, // B32
    { grid: 3, bit: 13 }, // B33
    { grid: 3, bit: 9 },  // B34
    { grid: 3, bit: 5 },  // B35
    { grid: 3, bit: 1 },  // B36

    { grid: 3, bit: 32 }, // B37
    { grid: 3, bit: 28 }, // B38
    { grid: 3, bit: 24 }, // B39
    { grid: 3, bit: 20 }, // B40
    { grid: 3, bit: 16 }, // B41
    { grid: 3, bit: 12 }, // B42
    { grid: 3, bit: 8 },  // B43
    { grid: 3, bit: 4 },  // B44
    { grid: 3, bit: 0 },  // B45

    { grid: 4, bit: 35 }, // B46
    { grid: 4, bit: 31 }, // B47
    { grid: 4, bit: 27 }, // B48
    { grid: 4, bit: 23 }, // B49
    { grid: 4, bit: 19 }, // B50
    { grid: 4, bit: 15 }, // B51
    { grid: 4, bit: 11 }, // B52
    { grid: 4, bit: 7 },  // B53
    { grid: 4, bit: 3 },  // B54

    { grid: 4, bit: 34 }, // B55
    { grid: 4, bit: 30 }, // B56
    { grid: 4, bit: 26 }, // B57
    { grid: 4, bit: 22 }, // B58
    { grid: 4, bit: 18 }, // B59
    { grid: 4, bit: 14 }, // B60
    { grid: 4, bit: 10 }, // B61
    { grid: 4, bit: 6 },  // B62
    { grid: 4, bit: 2 },  // B63

    { grid: 4, bit: 33 }, // B64
    { grid: 4, bit: 29 }, // B65
    { grid: 4, bit: 25 }, // B66
    { grid: 4, bit: 21 }, // B67
    { grid: 4, bit: 17 }, // B68
    { grid: 4, bit: 13 }, // B69
    { grid: 4, bit: 9 },  // B70
    { grid: 4, bit: 5 },  // B71
    { grid: 4, bit: 1 },  // B72
  ]);

  const gutterChasePattern = Object.freeze([0x18, 0x39, 0x5A, 0x9C]);
  const gutterDoubleChasePattern = Object.freeze([0x18, 0x39, 0x7B, 0xDE, 0x9C, 0x18]);

  // Frame table + frame count per frame-driven pattern (switch in updateBarPattern).
  const FRAME_TABLES = Object.freeze({
    [Pattern.BELL_SWEEP]: [Bell_Sweep, Bell_SweepFrameCount],
    [Pattern.CHEVRON_DN_1X4]: [Chevron_DN_1x4, Chevron_DN_1x4FrameCount],
    [Pattern.CHEVRON_DN_2X3]: [Chevron_DN_2x3, Chevron_DN_2x3FrameCount],
    [Pattern.CHEVRON_DN_2X3X1X3]: [Chevron_DN_2x3x1x3, Chevron_DN_2x3x1x3FrameCount],
    [Pattern.CHEVRON_DN_2X4]: [Chevron_DN_2x4, Chevron_DN_2x4FrameCount],
    [Pattern.CHEVRON_DN_3X2X1X2X2]: [Chevron_DN_3x2x1x2x2, Chevron_DN_3x2x1x2x2FrameCount],
    [Pattern.CHEVRON_DN_3X3X1X3]: [Chevron_DN_3x3x1x3, Chevron_DN_3x3x1x3FrameCount],
    [Pattern.CHEVRON_UP_1X4]: [Chevron_UP_1x4, Chevron_UP_1x4FrameCount],
    [Pattern.CHEVRON_UP_2X3]: [Chevron_UP_2x3, Chevron_UP_2x3FrameCount],
    [Pattern.DATA_PROCESSING]: [DataProcessing, DataProcessingFrameCount],
    [Pattern.RIGHT_ARROW_SWEEP]: [Right_Arrow_sweep, Right_Arrow_sweepFrameCount],
    [Pattern.SINWAVE]: [SinWave, SinWaveFrameCount],
    [Pattern.TV_STATIC]: [TVStatic, TVStaticFrameCount],
    [Pattern.VERTICAL_SINEWAVE]: [vertical_sinewave, vertical_sinewaveFrameCount],
    [Pattern.WATER_FALL_1X3]: [Water_Fall_1x3, Water_Fall_1x3FrameCount],
    [Pattern.WATER_FALL_1X4]: [Water_Fall_1x4, Water_Fall_1x4FrameCount],
    [Pattern.WATER_FALL_2X5]: [Water_Fall_2x5, Water_Fall_2x5FrameCount],
    [Pattern.WATERFALL_3X2]: [Waterfall_3x2, Waterfall_3x2FrameCount],
    [Pattern.WATERFALL_4X1]: [Waterfall_4x1, Waterfall_4x1FrameCount],
  });

  // Bar period applied by setPattern(p) for each frame-driven pattern.
  const DISPLAY_TIMES = Object.freeze({
    [Pattern.BELL_SWEEP]: Bell_SweepDisplayTime,
    [Pattern.CHEVRON_DN_1X4]: Chevron_DN_1x4DisplayTime,
    [Pattern.CHEVRON_DN_2X3]: Chevron_DN_2x3DisplayTime,
    [Pattern.CHEVRON_DN_2X3X1X3]: Chevron_DN_2x3x1x3DisplayTime,
    [Pattern.CHEVRON_DN_2X4]: Chevron_DN_2x4DisplayTime,
    [Pattern.CHEVRON_DN_3X2X1X2X2]: Chevron_DN_3x2x1x2x2DisplayTime,
    [Pattern.CHEVRON_DN_3X3X1X3]: Chevron_DN_3x3x1x3DisplayTime,
    [Pattern.CHEVRON_UP_1X4]: Chevron_UP_1x4DisplayTime,
    [Pattern.CHEVRON_UP_2X3]: Chevron_UP_2x3DisplayTime,
    [Pattern.DATA_PROCESSING]: DataProcessingDisplayTime,
    [Pattern.RIGHT_ARROW_SWEEP]: Right_Arrow_sweepDisplayTime,
    [Pattern.SINWAVE]: SinWaveDisplayTime,
    [Pattern.TV_STATIC]: TVStaticDisplayTime,
    [Pattern.VERTICAL_SINEWAVE]: vertical_sinewaveDisplayTime,
    [Pattern.WATER_FALL_1X3]: Water_Fall_1x3DisplayTime,
    [Pattern.WATER_FALL_1X4]: Water_Fall_1x4DisplayTime,
    [Pattern.WATER_FALL_2X5]: Water_Fall_2x5DisplayTime,
    [Pattern.WATERFALL_3X2]: Waterfall_3x2DisplayTime,
    [Pattern.WATERFALL_4X1]: Waterfall_4x1DisplayTime,
  });

  const u32 = (v) => v >>> 0;
  const u8 = (v) => v & 0xff;
  const MASK64 = (1n << 64n) - 1n;
  const kZero = Object.freeze([0, 0, 0, 0, 0, 0, 0, 0]);

  class EqService {
    /// @param vfd Shared display driver instance (NS.VfdDriver).
    constructor(vfd) {
      this.vfd_ = vfd;
      this.currentPattern = Pattern.PATTERN_OFF; // uninitialised in C++ until init()
      this.currentGutterPattern = GutterPattern.OFF;
      this.gutterSource = GutterSource.INDEPENDENT;
      this.bars = [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF];
      this.gutter = 0x00;
      this.gridMask_ = new Array(kGridCount).fill(0n);
      this.lastGridMask_ = new Array(kGridCount).fill(0n);
      this.setMask_ = new Array(kGridCount).fill(0n);
      this.lastUpdateTime = 0;
      this.periodTime = 200;
      this.gutterPeriodTime = 200;
      this.lastGutterUpdateTime = 0;
      this.isBlinkOn = false;
      this.isGutterBlinkOn = false;
      this.enabled = true;
      this.gutterChasePos = 0;
      this.animationPhase = 0;

      this.mic_ = null;
      this.micHeight_ = [0, 0, 0, 0, 0, 0, 0, 0];
      this.peakRow_ = [0, 0, 0, 0, 0, 0, 0, 0];
      this.lastBarFall_ = [0, 0, 0, 0, 0, 0, 0, 0];
      this.peakHoldUntil_ = [0, 0, 0, 0, 0, 0, 0, 0];
      this.lastPeakFall_ = [0, 0, 0, 0, 0, 0, 0, 0];
    }

    /// @brief Initialize EQ state, timers, and initial rendered pattern.
    init() {
      this.currentPattern = Pattern.PATTERN_OFF;
      this.currentGutterPattern = GutterPattern.OFF;
      this.gutterSource = GutterSource.INDEPENDENT;

      this.enabled = true;
      this.lastUpdateTime = 0;
      this.lastGutterUpdateTime = 0;
      this.periodTime = SinWaveDisplayTime;
      this.gutterPeriodTime = 200;

      this.isBlinkOn = false;
      this.isGutterBlinkOn = false;
      this.gutterChasePos = 0;

      this.gutter = 0x00;

      for (let i = 0; i < kGridCount; i++) {
        this.gridMask_[i] = 0n;
        this.setMask_[i] = 0n;
        this.lastGridMask_[i] = 0n;
      }

      this.barsToBits();
      for (let i = 0; i < kGridCount; i++) this.setMask_[i] = this.gridMask_[i];
    }

    /// @brief Attach the microphone used by the MIC_* patterns (NS.MicService).
    setMicSource(mic) {
      this.mic_ = mic || null;
    }

    /// @brief True if the pattern draws from the microphone.
    static isMicPattern(p) {
      return p === Pattern.MIC_LIVE || p === Pattern.MIC_PEAK;
    }

    // ── private helpers (names kept from the C++) ────────────────
    clearLastBits() {
      this.subtractGridBitMasks(this.lastGridMask_);
      for (let i = 0; i < kGridCount; i++) this.lastGridMask_[i] = 0n;
    }

    barsToBits() {
      for (let i = 0; i < kGridCount; i++) this.gridMask_[i] = 0n;

      for (let row = 0; row < 9; row++) {
        const rowBits = this.bars[row];
        for (let col = 0; col < 8; col++) {
          if (!(rowBits & (1 << col))) continue;
          const B = u8(col * 9 + (row + 1));
          const s = barLut[B - 1];
          if (s.grid < kFirstGrid || s.grid > kLastGrid) continue;
          const localGrid = u8(s.grid - kFirstGrid);
          this.gridMask_[localGrid] |= (1n << BigInt(s.bit));
        }
      }
    }

    gutterToBits() {
      for (let i = 0; i < 8; i++) {
        if (!(this.gutter & (1 << i))) continue;
        const s = gutterLut_[i];
        if (s.grid < kFirstGrid || s.grid > kLastGrid) continue;
        const localGrid = u8(s.grid - kFirstGrid);
        this.gridMask_[localGrid] |= (1n << BigInt(s.bit));
      }
    }

    renderComposite() {
      this.barsToBits();
      this.gutterToBits();
      this.clearLastBits();
      this.applyGridBitMasks(this.gridMask_);
      this.vfd_.buildFrames();
    }

    /// C++ overloads, all mapped onto this one method:
    ///   setPattern(p)
    ///   setPattern(p, interval)                         -> second arg is a number, no 3rd arg
    ///   setPattern(p, gutterPattern)                    -> use setPattern(p, undefined, gutterPattern)
    ///                                                      or setPatternWithGutter(p, gutterPattern)
    ///   setPattern(p, interval, gutterPattern, gutterInterval)
    /// Because Pattern/GutterPattern/interval are all plain numbers in JS, the
    /// 2-arg (p, gutterPattern) C++ form cannot be told apart from (p, interval)
    /// by type; pass `undefined`/`null` as the interval to select it, or call
    /// setPatternWithGutter(). A 3-arg call (p, interval, gutterPattern) applies the
    /// interval and gutter pattern while keeping the gutter period from the pattern.
    setPattern(newPattern, interval, gutterPattern, gutterInterval) {
      const hasInterval = interval !== undefined && interval !== null;
      const hasGutter = gutterPattern !== undefined && gutterPattern !== null;
      const hasGutterInterval = gutterInterval !== undefined && gutterInterval !== null;

      if (!hasInterval && !hasGutter) {
        this._setPatternOnly(newPattern);
      } else if (hasInterval && !hasGutter) {
        // setPattern(Pattern, uint32_t)
        this._setPatternOnly(newPattern);
        this.setBarPeriod(interval);
      } else if (!hasInterval && hasGutter) {
        // setPattern(Pattern, GutterPattern)
        this._setPatternOnly(newPattern);
        this.gutterSource = GutterSource.INDEPENDENT;
        this.setGutterPattern(gutterPattern);
      } else {
        // setPattern(Pattern, uint32_t, GutterPattern, uint32_t)
        this._setPatternOnly(newPattern);
        this.setBarPeriod(interval);
        this.gutterSource = GutterSource.INDEPENDENT;
        if (hasGutterInterval) this.setGutterPattern(gutterPattern, gutterInterval);
        else this.setGutterPattern(gutterPattern);
      }
    }

    /// Explicit alias for the C++ overload setPattern(Pattern, GutterPattern).
    setPatternWithGutter(newPattern, gutterPattern) {
      this.setPattern(newPattern, undefined, gutterPattern);
    }

    // C++ setPattern(Pattern newPattern) body.
    _setPatternOnly(newPattern) {
      this.currentPattern = newPattern;
      this.animationPhase = 0;

      switch (newPattern) {
        case Pattern.PATTERN_OFF:
        case Pattern.PATTERN_ON:
          this.setBarPeriod(100);
          this.gutterSource = GutterSource.INDEPENDENT;
          this.setGutterPattern(GutterPattern.OFF);
          break;
        case Pattern.PATTERN_BLINK:
          this.setBarPeriod(400);
          this.gutterSource = GutterSource.INDEPENDENT;
          this.setGutterPattern(GutterPattern.OFF);
          break;
        case Pattern.MIC_LIVE:
        case Pattern.MIC_PEAK:
          this.setBarPeriod(30);
          this.gutterSource = GutterSource.INDEPENDENT;
          this.resetMicState();
          break;
        default:
          if (Object.prototype.hasOwnProperty.call(DISPLAY_TIMES, newPattern)) {
            this.setBarPeriod(DISPLAY_TIMES[newPattern]);
            this.gutterSource = GutterSource.FROM_BAR_PATTERN;
          } else {
            this.setBarPeriod(500);
            this.gutterSource = GutterSource.INDEPENDENT;
            this.setGutterPattern(GutterPattern.OFF);
          }
          break;
      }

      this.syncMicRunning();
    }

    resetMicState() {
      for (let c = 0; c < 8; c++) {
        this.micHeight_[c] = 0;
        this.peakRow_[c] = 0;
        this.lastBarFall_[c] = 0;
        this.peakHoldUntil_[c] = 0;
        this.lastPeakFall_[c] = 0;
      }
    }

    syncMicRunning() {
      const mic = this.mic_;
      if (!mic) return;

      const want = this.enabled && EqService.isMicPattern(this.currentPattern) && this.vfd_.isDisplayPowerOn();
      if (want && !mic.isRunning()) {
        mic.start();
      } else if (!want && mic.isRunning()) {
        mic.stop();
      }
    }

    updateMicPattern(now, withPeak) {
      const newFrame = !!(this.mic_ && this.mic_.hasNewFrame());
      if (!newFrame && u32(now - this.lastUpdateTime) < this.periodTime) return false;
      this.lastUpdateTime = now;

      const levels = this.mic_ ? this.mic_.levels() : kZero;

      for (let c = 0; c < 8; c++) {
        let target = u8(levels[c] | 0);
        if (target > 9) target = 9;

        // Bar: instant attack, rate-limited release.
        if (target >= this.micHeight_[c]) {
          this.micHeight_[c] = target;
          this.lastBarFall_[c] = now;
        } else if (u32(now - this.lastBarFall_[c]) >= kMicBarFallMs) {
          this.micHeight_[c]--;
          this.lastBarFall_[c] = now;
        }

        // Peak: jump to bar top, hold, then fall one row at a time.
        if (this.micHeight_[c] >= this.peakRow_[c]) {
          this.peakRow_[c] = this.micHeight_[c];
          this.peakHoldUntil_[c] = u32(now + kMicPeakHoldMs);
          this.lastPeakFall_[c] = now;
        } else if (((now - this.peakHoldUntil_[c]) | 0) >= 0 &&
                   u32(now - this.lastPeakFall_[c]) >= kMicPeakFallMs) {
          this.peakRow_[c]--; // stays >= micHeight_ since it was strictly greater
          this.lastPeakFall_[c] = now;
        }
      }

      // Render: bars[0] is the top row, so a height h lights rows 9-h..8.
      const newBars = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let c = 0; c < 8; c++) {
        const bit = u8(1 << c);
        for (let r = u8(9 - this.micHeight_[c]); r < 9; r++) newBars[r] |= bit;
        if (withPeak && this.peakRow_[c] > 0) newBars[9 - this.peakRow_[c]] |= bit;
      }

      let changed = false;
      for (let r = 0; r < 9; r++) {
        if (this.bars[r] !== newBars[r]) {
          this.bars[r] = newBars[r];
          changed = true;
        }
      }
      return changed;
    }

    /// C++ overloads: setGutterPattern(gp) and setGutterPattern(gp, gutterInterval).
    setGutterPattern(newPattern, gutterInterval) {
      this.currentGutterPattern = newPattern;
      this.isGutterBlinkOn = false;
      this.gutterChasePos = 0;

      switch (newPattern) {
        case GutterPattern.OFF:
          this.gutter = 0x00;
          this.gutterPeriodTime = 200;
          break;
        case GutterPattern.ON:
          this.gutter = 0xFF;
          this.gutterPeriodTime = 200;
          break;
        case GutterPattern.BLINK:
          this.gutter = 0x00;
          this.gutterPeriodTime = 400;
          break;
        case GutterPattern.CHASE:
          this.gutter = 0x01;
          this.gutterPeriodTime = 120;
          break;
        case GutterPattern.DOUBLE_CHASE:
          this.gutter = 0x18;
          this.gutterPeriodTime = 300;
          break;
        default:
          this.gutter = 0x00;
          this.gutterPeriodTime = 200;
          break;
      }

      if (gutterInterval !== undefined && gutterInterval !== null) {
        const v = u32(gutterInterval);
        this.gutterPeriodTime = (v === 0) ? 1 : v;
      }
    }

    /// @brief Set bar update period (ms).
    setBarPeriod(period) {
      const v = u32(period);
      this.periodTime = (v === 0) ? 1 : v;
    }

    /// @brief Set gutter update period (ms).
    setGutterPeriod(period) {
      const v = u32(period);
      this.gutterPeriodTime = (v === 0) ? 1 : v;
    }

    applyGridBitMasks(updateGridMask) {
      for (let i = 0; i < kGridCount; i++) {
        this.vfd_.orGridBits(u8(i + kFirstGrid), updateGridMask[i]);
        this.lastGridMask_[i] = updateGridMask[i];
      }
    }

    subtractGridBitMasks(updateGridMask) {
      for (let i = 0; i < kGridCount; i++) {
        // ~uint64 in C++: complement within 64 bits.
        this.vfd_.andGridBits(u8(i + kFirstGrid), (~updateGridMask[i]) & MASK64);
      }
    }

    /// @brief Enable periodic bar/gutter updates and rendering.
    enable() {
      this.enabled = true;
      this.syncMicRunning();
    }

    /// @brief Disable periodic updates (and clear EQ bits).
    disable() {
      this.enabled = false;
      this.syncMicRunning();
      this.clearLastBits();
      this.vfd_.buildFrames();
    }

    /// @brief Clear EQ-managed bits from EQ grids.
    clear() {
      this.clearLastBits();
      for (let i = 0; i < kGridCount; i++) {
        this.gridMask_[i] = 0n;
        this.setMask_[i] = 0n;
      }
      this.vfd_.buildFrames();
    }

    updateBarPattern(now) {
      const updateFromFrames = (frames, frameCount) => {
        if (u32(now - this.lastUpdateTime) < this.periodTime) return false;
        this.lastUpdateTime = now;

        const f = frames[this.animationPhase];
        for (let i = 0; i < 9; i++) this.bars[i] = f[i];

        if (this.gutterSource === GutterSource.FROM_BAR_PATTERN) this.gutter = f[9];

        this.animationPhase = ((this.animationPhase + 1) % frameCount) & 0xffff;
        return true;
      };

      switch (this.currentPattern) {
        case Pattern.PATTERN_OFF:
          for (let i = 0; i < 9; i++) this.bars[i] = 0x00;
          return true;

        case Pattern.PATTERN_ON:
          for (let i = 0; i < 9; i++) this.bars[i] = 0xFF;
          return true;

        case Pattern.PATTERN_BLINK:
          if (u32(now - this.lastUpdateTime) < this.periodTime) return false;
          this.lastUpdateTime = now;
          this.isBlinkOn = !this.isBlinkOn;
          for (let i = 0; i < 9; i++) this.bars[i] = this.isBlinkOn ? 0xFF : 0x00;
          return true;

        case Pattern.MIC_LIVE:
          return this.updateMicPattern(now, false);

        case Pattern.MIC_PEAK:
          return this.updateMicPattern(now, true);

        default: {
          const t = FRAME_TABLES[this.currentPattern];
          if (!t) return false;
          return updateFromFrames(t[0], t[1]);
        }
      }
    }

    updateGutterPattern(now) {
      if (this.gutterSource !== GutterSource.INDEPENDENT) return false;

      switch (this.currentGutterPattern) {
        case GutterPattern.OFF:
          if (this.gutter !== 0x00) { this.gutter = 0x00; return true; }
          return false;

        case GutterPattern.ON:
          if (this.gutter !== 0xFF) { this.gutter = 0xFF; return true; }
          return false;

        case GutterPattern.BLINK:
          if (u32(now - this.lastGutterUpdateTime) < this.gutterPeriodTime) return false;
          this.lastGutterUpdateTime = now;
          this.isGutterBlinkOn = !this.isGutterBlinkOn;
          this.gutter = this.isGutterBlinkOn ? 0xFF : 0x00;
          return true;

        case GutterPattern.CHASE:
          if (u32(now - this.lastGutterUpdateTime) < this.gutterPeriodTime) return false;
          this.lastGutterUpdateTime = now;
          this.gutter = gutterChasePattern[this.gutterChasePos];
          this.gutterChasePos = this.gutterChasePos + 1;
          if (this.gutterChasePos >= 4) this.gutterChasePos = 0;
          return true;

        case GutterPattern.DOUBLE_CHASE:
          if (u32(now - this.lastGutterUpdateTime) < this.gutterPeriodTime) return false;
          this.lastGutterUpdateTime = now;
          this.gutter = gutterDoubleChasePattern[this.gutterChasePos];
          this.gutterChasePos = u8(this.gutterChasePos + 1);
          if (this.gutterChasePos >= 6) this.gutterChasePos = 0;
          return true;

        default:
          return false;
      }
    }

    /// @brief Advance bar and gutter animations.
    /// @param now Current system time in milliseconds (uint32).
    update(now) {
      now = u32(now);
      // Stops the mic while the display is off (e.g. display timeout) and
      // restarts it when the display comes back.
      this.syncMicRunning();

      if (!this.enabled) return;

      const barChanged = this.updateBarPattern(now);
      const gutterChanged = this.updateGutterPattern(now);

      if (barChanged || gutterChanged) this.renderComposite();
    }
  }

  EqService.Pattern = Pattern;
  EqService.GutterPattern = GutterPattern;
  EqService.GutterSource = GutterSource;
  EqService.kFirstGrid = kFirstGrid;
  EqService.kLastGrid = kLastGrid;
  EqService.kGridCount = kGridCount;
  // Raw animation tables, exposed read-only for tooling (e.g. editor previews).
  EqService.FRAME_TABLES = FRAME_TABLES;
  EqService.DISPLAY_TIMES = DISPLAY_TIMES;

  NS.EqService = EqService;
})(typeof window !== 'undefined' ? window : globalThis);
