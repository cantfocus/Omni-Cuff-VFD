// Port of src/DiscService.h/.cpp — grid 1 disc segments, pinwheel and swoosh animations.
// Masks are BigInt (uint64 in C++); small counters stay Number with uint8/uint32 wrap emulated.
(function (G) {
  'use strict';
  const NS = G.VFDSim = G.VFDSim || {};

  const DISC = Object.freeze({
    DISC1_EDGE: 0,
    DISC1_HUB: 1,
    DISC2_EDGE: 2,
    DISC2_HUB: 3,
    DISC2_WHEEL: 4,
    DISC3_EDGE: 5,
    DISC3_HUB: 6,
    DISC3_WHEEL: 7,
    DISC_COUNT: 8,
  });

  const PinwheelPattern = Object.freeze({
    OFF: 0,
    CHASE: 1,
    FILL_PAUSE_DRAIN_PAUSE: 2,
    CHASE_3: 3,
    CHASE_3_INV: 4,
  });

  const SwooshPattern = Object.freeze({
    OFF: 0,
    SWEEP: 1,
    CHASE: 2,
    CHASE_INV: 3,
  });

  const kDiscBitByIndex = [
    10, // DISC1_EDGE (S1)
    15, // DISC1_HUB  (S10)
    30, // DISC2_EDGE (S2)
    32, // DISC2_HUB  (S20)
    31, // DISC2_WHEEL (S21)
    21, // DISC3_EDGE (S3)
    23, // DISC3_HUB  (S22)
    22, // DISC3_WHEEL (S23)
  ];

  const kPinwheelBits = [
    11, // S11 (order 0)
    12, // S12 (order 1)
    14, // S13 (order 2)
    17, // S14 (order 3)
    19, // S15 (order 4)
    20, // S16 (order 5)
    18, // S17 (order 6)
    16, // S18 (order 7)
    13, // S19 (order 8)
  ];

  const kSwooshBits = [
    29, // S4
    28, // S5
    27, // S6
    26, // S7
    25, // S8
    24, // S9
  ];

  const kPinwheelCount = kPinwheelBits.length;
  const kSwooshCount = kSwooshBits.length;
  const kDiscCount = DISC.DISC_COUNT;
  const kGrid = 1;

  const not64 = (x) => BigInt.asUintN(64, ~x);
  const u8 = (v) => (v & 0xff);
  const u32 = (v) => (v >>> 0);

  function bitMask(bit) {
    return (bit < 36) ? (1n << BigInt(bit)) : 0n;
  }

  function isValidDiscIndex(index) {
    return Number.isInteger(index) && index >= 0 && index < kDiscCount;
  }

  class DiscService {
    /** @param {VFDSim.VfdDriver} vfd */
    constructor(vfd) {
      this.vfd_ = vfd;
      this.discMaskByIndex_ = new Array(kDiscCount).fill(0n);
      this.init();
    }

    init() {
      this.discMask_ = 0n;
      this.pinwheelMask_ = 0n;
      this.swooshMask_ = 0n;
      this.managedMask_ = 0n;

      this.pinwheelPattern_ = PinwheelPattern.OFF;
      this.swooshPattern_ = SwooshPattern.OFF;
      this.pinwheelEnabled_ = false;
      this.swooshEnabled_ = false;
      this.pinwheelForward_ = true;
      this.swooshForward_ = true;

      this.pinwheelPeriodMs_ = 120;
      this.swooshPeriodMs_ = 120;
      this.pinwheelLastMs_ = 0;
      this.swooshLastMs_ = 0;
      this.pinwheelIndex_ = 0;
      this.swooshIndex_ = 0;

      for (let i = 0; i < kDiscCount; ++i) {
        this.discMaskByIndex_[i] = bitMask(kDiscBitByIndex[i]);
        this.managedMask_ |= this.discMaskByIndex_[i];
      }
      for (let i = 0; i < kPinwheelCount; ++i) this.managedMask_ |= bitMask(kPinwheelBits[i]);
      for (let i = 0; i < kSwooshCount; ++i) this.managedMask_ |= bitMask(kSwooshBits[i]);

      this.apply();
    }

    apply() {
      let animatedMask = 0n;
      if (this.pinwheelEnabled_) animatedMask |= this.pinwheelMask_;
      if (this.swooshEnabled_) animatedMask |= this.swooshMask_;

      const combined = this.discMask_ | animatedMask;

      this.vfd_.andGridBits(kGrid, not64(this.managedMask_));
      this.vfd_.orGridBits(kGrid, combined);
      this.vfd_.buildFrames();
    }

    /** @param {number} disc DiscService.DISC value */
    on(disc) {
      if (!isValidDiscIndex(disc)) return;
      this.discMask_ |= this.discMaskByIndex_[disc];
      this.apply();
    }

    off(disc) {
      if (!isValidDiscIndex(disc)) return;
      this.discMask_ &= not64(this.discMaskByIndex_[disc]);
      this.apply();
    }

    toggle(disc) {
      if (!isValidDiscIndex(disc)) return;
      this.discMask_ ^= this.discMaskByIndex_[disc];
      this.apply();
    }

    onAll() {
      let all = 0n;
      for (let i = 0; i < kDiscCount; ++i) all |= this.discMaskByIndex_[i];
      this.discMask_ = all;
      this.apply();
    }

    offAll() {
      this.discMask_ = 0n;
      this.apply();
    }

    getState(disc) {
      if (!isValidDiscIndex(disc)) return false;
      return (this.discMask_ & this.discMaskByIndex_[disc]) !== 0n;
    }

    getCount() {
      let count = 0;
      let value = this.discMask_;
      while (value !== 0n) {
        count += Number(value & 1n);
        value >>= 1n;
      }
      return u8(count);
    }

    /** @param {number} pattern DiscService.PinwheelPattern value */
    setPinwheelPattern(pattern) {
      pattern = u8(pattern);
      this.pinwheelPattern_ = pattern;
      this.pinwheelIndex_ = 0;

      if (pattern === PinwheelPattern.OFF) {
        this.pinwheelMask_ = 0n;
        this.apply();
        return;
      }

      if (pattern === PinwheelPattern.CHASE) {
        const pos = this.pinwheelForward_ ? 0 : (kPinwheelCount - 1);
        this.pinwheelMask_ = bitMask(kPinwheelBits[pos]);
        this.apply();
        return;
      }

      if (pattern === PinwheelPattern.FILL_PAUSE_DRAIN_PAUSE) {
        const pos = this.pinwheelForward_ ? 0 : (kPinwheelCount - 1);
        this.pinwheelMask_ = bitMask(kPinwheelBits[pos]);
        this.apply();
        return;
      }

      const phase = 0;
      let mask = 0n;
      for (let i = 0; i < kPinwheelCount; ++i) {
        const pos = this.pinwheelForward_ ? i : (kPinwheelCount - 1 - i);
        const everyThird = ((i % 3) === phase);
        if ((pattern === PinwheelPattern.CHASE_3 && everyThird) ||
            (pattern === PinwheelPattern.CHASE_3_INV && !everyThird)) {
          mask |= bitMask(kPinwheelBits[pos]);
        }
      }
      this.pinwheelMask_ = mask;

      this.apply();
    }

    /** @param {number} pattern DiscService.SwooshPattern value */
    setSwooshPattern(pattern) {
      pattern = u8(pattern);
      this.swooshPattern_ = pattern;
      this.swooshIndex_ = 0;

      if (pattern === SwooshPattern.OFF) {
        this.swooshMask_ = 0n;
      } else if (pattern === SwooshPattern.SWEEP) {
        this.swooshMask_ = bitMask(kSwooshBits[0]);
        this.setSwooshPeriod(120);
      } else if (pattern === SwooshPattern.CHASE) {
        let mask = 0n;
        this.setSwooshPeriod(200);
        for (let i = 0; i < kSwooshCount; ++i) {
          if ((i % 3) === 0) mask |= bitMask(kSwooshBits[i]);
        }
        this.swooshMask_ = mask;
      } else {
        let mask = 0n;
        this.setSwooshPeriod(200);
        for (let i = 0; i < kSwooshCount; ++i) {
          if ((i % 3) !== 0) mask |= bitMask(kSwooshBits[i]);
        }
        this.swooshMask_ = mask;
      }

      this.apply();
    }

    setPinwheelEnabled(enabled) {
      this.pinwheelEnabled_ = !!enabled;
      this.apply();
    }

    setSwooshEnabled(enabled) {
      this.swooshEnabled_ = !!enabled;
      this.apply();
    }

    setPinwheelDirection(forward) { this.pinwheelForward_ = !!forward; }
    setSwooshDirection(forward) { this.swooshForward_ = !!forward; }
    setPinwheelReverse(reverse) { this.setPinwheelDirection(!reverse); }
    setSwooshReverse(reverse) { this.setSwooshDirection(!reverse); }
    getPinwheelDirection() { return this.pinwheelForward_; }
    getSwooshDirection() { return this.swooshForward_; }
    getPinwheelReverse() { return !this.pinwheelForward_; }
    getSwooshReverse() { return !this.swooshForward_; }

    setPinwheelPeriod(periodMs) {
      periodMs = u32(periodMs);
      this.pinwheelPeriodMs_ = (periodMs === 0) ? 1 : periodMs;
    }

    setSwooshPeriod(periodMs) {
      periodMs = u32(periodMs);
      this.swooshPeriodMs_ = (periodMs === 0) ? 1 : periodMs;
    }

    stepPinwheel() {
      if (this.pinwheelPattern_ === PinwheelPattern.OFF) {
        this.pinwheelMask_ = 0n;
        return;
      }

      if (this.pinwheelPattern_ === PinwheelPattern.CHASE) {
        this.pinwheelMask_ = bitMask(kPinwheelBits[this.pinwheelIndex_]);
        const step = this.pinwheelForward_ ? 1 : (kPinwheelCount - 1);
        this.pinwheelIndex_ = u8((this.pinwheelIndex_ + step) % kPinwheelCount);
        return;
      }

      if (this.pinwheelPattern_ === PinwheelPattern.FILL_PAUSE_DRAIN_PAUSE) {
        const phase = this.pinwheelIndex_;
        let mask = 0n;

        if (phase <= 8) {
          for (let i = 0; i <= phase; ++i) {
            const pos = this.pinwheelForward_ ? i : (kPinwheelCount - 1 - i);
            mask |= bitMask(kPinwheelBits[pos]);
          }
        } else if (phase === 9) {
          for (let i = 0; i < kPinwheelCount; ++i) {
            const pos = this.pinwheelForward_ ? i : (kPinwheelCount - 1 - i);
            mask |= bitMask(kPinwheelBits[pos]);
          }
        } else if (phase <= 18) {
          const offCount = u8(phase - 9);
          for (let i = offCount; i < kPinwheelCount; ++i) {
            const pos = this.pinwheelForward_ ? i : (kPinwheelCount - 1 - i);
            mask |= bitMask(kPinwheelBits[pos]);
          }
        } else {
          mask = 0n;
        }

        this.pinwheelMask_ = mask;
        this.pinwheelIndex_ = u8((this.pinwheelIndex_ + 1) % 20);
        return;
      }

      const phase = u8(this.pinwheelIndex_ % 3);
      let mask = 0n;
      for (let i = 0; i < kPinwheelCount; ++i) {
        const pos = this.pinwheelForward_ ? i : (kPinwheelCount - 1 - i);
        const everyThird = ((i % 3) === phase);
        if ((this.pinwheelPattern_ === PinwheelPattern.CHASE_3 && everyThird) ||
            (this.pinwheelPattern_ === PinwheelPattern.CHASE_3_INV && !everyThird)) {
          mask |= bitMask(kPinwheelBits[pos]);
        }
      }

      this.pinwheelMask_ = mask;
      const step = this.pinwheelForward_ ? 1 : 2;
      this.pinwheelIndex_ = u8((this.pinwheelIndex_ + step) % 3);
    }

    stepSwoosh() {
      if (this.swooshPattern_ === SwooshPattern.OFF) {
        this.swooshMask_ = 0n;
        return;
      }

      if (this.swooshPattern_ === SwooshPattern.SWEEP) {
        this.swooshMask_ = bitMask(kSwooshBits[this.swooshIndex_]);
        const step = this.swooshForward_ ? 1 : (kSwooshCount - 1);
        this.swooshIndex_ = u8((this.swooshIndex_ + step) % kSwooshCount);
        return;
      }

      const phase = u8(this.swooshIndex_ % 3);
      let mask = 0n;
      for (let i = 0; i < kSwooshCount; ++i) {
        const everyThird = ((i % 3) === phase);
        if ((this.swooshPattern_ === SwooshPattern.CHASE && everyThird) ||
            (this.swooshPattern_ === SwooshPattern.CHASE_INV && !everyThird)) {
          mask |= bitMask(kSwooshBits[i]);
        }
      }

      this.swooshMask_ = mask;
      const forwardStep = this.swooshForward_ ? 1 : 2;
      const inverseStep = this.swooshForward_ ? 2 : 1;
      if (this.swooshPattern_ === SwooshPattern.CHASE_INV) {
        this.swooshIndex_ = u8((this.swooshIndex_ + inverseStep) % 3);
      } else {
        this.swooshIndex_ = u8((this.swooshIndex_ + forwardStep) % 3);
      }
    }

    /** @param {number} now uint32 milliseconds */
    update(now) {
      now = u32(now);
      let changed = false;

      if (this.pinwheelEnabled_ && this.pinwheelPattern_ !== PinwheelPattern.OFF) {
        if (u32(now - this.pinwheelLastMs_) >= this.pinwheelPeriodMs_) {
          this.pinwheelLastMs_ = now;
          this.stepPinwheel();
          changed = true;
        }
      }

      if (this.swooshEnabled_ && this.swooshPattern_ !== SwooshPattern.OFF) {
        if (u32(now - this.swooshLastMs_) >= this.swooshPeriodMs_) {
          this.swooshLastMs_ = now;
          this.stepSwoosh();
          changed = true;
        }
      }

      if (changed) this.apply();
    }
  }

  DiscService.DISC = DISC;
  DiscService.PinwheelPattern = PinwheelPattern;
  DiscService.SwooshPattern = SwooshPattern;
  DiscService.kGrid = kGrid;

  NS.DiscService = DiscService;
})(typeof window !== 'undefined' ? window : globalThis);
