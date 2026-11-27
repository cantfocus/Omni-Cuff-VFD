// Port of src/TrackService.h/.cpp — 20 track segments + swirl indicator on grid 13.
(function (G) {
  'use strict';
  const NS = G.VFDSim = G.VFDSim || {};

  const kTrackCount = 20;
  const kTrackGrid = 13;
  const kSwirlBit = 15;

  const Animation = Object.freeze({
    NONE: 0,
    COUNT_UP: 1,
    FILL_UP: 2,
    COUNT_DOWN: 3,
    FILLED_DOWN: 4,
    COUNT_DOWN_WARNING: 5,
    RANDOM_TOGGLE: 6,
  });

  const kTrackBitByIndex = [
    19, 23, 27, 31, 35,
    18, 22, 26, 30, 34,
    17, 21, 25, 29, 33,
    16, 20, 24, 28, 32,
  ];

  const kSwirlMask = 1n << BigInt(kSwirlBit);
  const not64 = (x) => BigInt.asUintN(64, ~x);
  const u8 = (v) => (v & 0xff);
  const u32 = (v) => (v >>> 0);

  function isValidTrackNumber(n) { return n >= 1 && n <= kTrackCount; }
  function toIndex(n) { return u8(n - 1); }

  class TrackService {
    /** @param {VFDSim.VfdDriver} vfd */
    constructor(vfd) {
      this.vfd_ = vfd;
      this.trackMaskByIndex_ = new Array(kTrackCount).fill(0n);
      this.warningBlinkToggles = 12;
      // Members not reset by init() (C++ default member initializers).
      this.swirlBlinkRunning_ = false;
      this.swirlBlinkHalfPeriodMs_ = 250;
      this.lastSwirlBlinkTime_ = 0;
      this.init();
    }

    init() {
      this.allTracksMask_ = 0n;
      this.trackMask_ = 0n;
      this.swirlEnabled_ = false;
      this.currentAnimation_ = Animation.NONE;
      this.animationRunning_ = false;
      this.animationStepMs_ = 120;
      this.lastAnimationStepTime_ = 0;
      this.animationTrack_ = 1;
      this.animationFlashTogglesRemaining_ = 0;
      this.animationFlashAllOn_ = true;
      this.warningBlinkTogglesRemaining_ = 0;
      this.warningSwirlTogglesRemaining_ = 0;
      this.warningSwirlPhase_ = false;
      this.completionSwirlTogglesRemaining_ = 0;
      this.completionSwirlPhase_ = false;

      for (let i = 0; i < kTrackCount; ++i) {
        this.trackMaskByIndex_[i] = 1n << BigInt(kTrackBitByIndex[i]);
        this.allTracksMask_ |= this.trackMaskByIndex_[i];
      }
      // Note: C++ init() does not call rebuildCombinedMask().
    }

    setSingleTrackMask(trackNumber) {
      trackNumber = u8(trackNumber);
      if (!isValidTrackNumber(trackNumber)) {
        this.trackMask_ = 0n;
        return;
      }
      this.trackMask_ = this.trackMaskByIndex_[toIndex(trackNumber)];
    }

    setTracksUpToMask(trackNumber) {
      trackNumber = u8(trackNumber);
      if (trackNumber === 0) {
        this.trackMask_ = 0n;
        return;
      }
      if (trackNumber > kTrackCount) trackNumber = kTrackCount;

      let mask = 0n;
      for (let t = 1; t <= trackNumber; ++t) mask |= this.trackMaskByIndex_[toIndex(t)];
      this.trackMask_ = mask;
    }

    startAnimation(animation, stepMs) {
      stepMs = u32(stepMs);
      this.currentAnimation_ = animation;
      this.animationRunning_ = true;
      this.animationStepMs_ = (stepMs === 0) ? 1 : stepMs;
      this.lastAnimationStepTime_ = 0;
      this.animationTrack_ = 1;
      this.animationFlashTogglesRemaining_ = 0;
      this.animationFlashAllOn_ = true;
      this.warningBlinkTogglesRemaining_ = 0;
      this.warningSwirlTogglesRemaining_ = 0;
      this.warningSwirlPhase_ = false;
      this.completionSwirlTogglesRemaining_ = 0;
      this.completionSwirlPhase_ = false;

      this.swirlEnabled_ = true;

      switch (animation) {
        case Animation.COUNT_UP:
          this.animationTrack_ = 1;
          this.setSingleTrackMask(this.animationTrack_);
          break;
        case Animation.FILL_UP:
          this.animationTrack_ = 1;
          this.setTracksUpToMask(this.animationTrack_);
          break;
        case Animation.COUNT_DOWN:
          this.animationTrack_ = kTrackCount;
          this.setSingleTrackMask(this.animationTrack_);
          break;
        case Animation.FILLED_DOWN:
          this.animationTrack_ = kTrackCount;
          this.trackMask_ = this.allTracksMask_;
          break;
        case Animation.COUNT_DOWN_WARNING:
          this.animationTrack_ = kTrackCount;
          this.trackMask_ = this.allTracksMask_;
          this.warningBlinkTogglesRemaining_ = this.warningBlinkToggles;
          break;
        case Animation.RANDOM_TOGGLE:
          // clearOnStart already applied by startRandomToggle before this call
          break;
        case Animation.NONE:
        default:
          this.animationRunning_ = false;
          break;
      }

      this.rebuildCombinedMask();
    }

    /** @param {number} now uint32 milliseconds */
    update(now) {
      now = u32(now);

      // Independent swirl blink tick (runs alongside any animation)
      if (this.swirlBlinkRunning_) {
        if (u32(now - this.lastSwirlBlinkTime_) >= this.swirlBlinkHalfPeriodMs_) {
          this.lastSwirlBlinkTime_ = now;
          this.swirlEnabled_ = !this.swirlEnabled_;
          this.rebuildCombinedMask();
        }
      }

      if (!this.animationRunning_ || this.currentAnimation_ === Animation.NONE) return;

      if (u32(now - this.lastAnimationStepTime_) < this.animationStepMs_) return;
      this.lastAnimationStepTime_ = now;

      if (this.completionSwirlTogglesRemaining_ > 0) {
        this.completionSwirlPhase_ = !this.completionSwirlPhase_;
        this.swirlEnabled_ = this.completionSwirlPhase_;
        --this.completionSwirlTogglesRemaining_;
        this.rebuildCombinedMask();

        if (this.completionSwirlTogglesRemaining_ === 0) {
          this.swirlEnabled_ = false;
          this.rebuildCombinedMask();
          this.stopAnimation();
        }
        return;
      }

      switch (this.currentAnimation_) {
        case Animation.COUNT_UP:
          if (this.animationTrack_ >= kTrackCount) {
            this.trackMask_ = 0n;
            this.completionSwirlPhase_ = true;
            this.completionSwirlTogglesRemaining_ = 8;
            this.rebuildCombinedMask();
            return;
          }
          this.animationTrack_ = u8(this.animationTrack_ + 1);
          this.setSingleTrackMask(this.animationTrack_);
          this.rebuildCombinedMask();
          return;

        case Animation.FILL_UP:
          if (this.animationFlashTogglesRemaining_ > 0) {
            this.animationFlashAllOn_ = !this.animationFlashAllOn_;
            this.trackMask_ = this.animationFlashAllOn_ ? this.allTracksMask_ : 0n;
            --this.animationFlashTogglesRemaining_;

            if (this.animationFlashTogglesRemaining_ === 0) {
              this.trackMask_ = this.allTracksMask_;
              this.rebuildCombinedMask();
              this.stopAnimation();
              return;
            }

            this.rebuildCombinedMask();
            return;
          }

          if (this.animationTrack_ < kTrackCount) {
            this.animationTrack_ = u8(this.animationTrack_ + 1);
            this.setTracksUpToMask(this.animationTrack_);
            this.rebuildCombinedMask();
            return;
          }

          this.animationFlashTogglesRemaining_ = 8;
          this.animationFlashAllOn_ = true;
          return;

        case Animation.COUNT_DOWN:
          if (this.animationTrack_ <= 1) {
            this.trackMask_ = 0n;
            this.completionSwirlPhase_ = true;
            this.completionSwirlTogglesRemaining_ = 8;
            this.rebuildCombinedMask();
            return;
          }
          this.animationTrack_ = u8(this.animationTrack_ - 1);
          this.setSingleTrackMask(this.animationTrack_);
          this.rebuildCombinedMask();
          return;

        case Animation.FILLED_DOWN:
          if (this.animationTrack_ === 0) {
            this.stopAnimation();
            return;
          }

          this.trackMask_ &= not64(this.trackMaskByIndex_[toIndex(this.animationTrack_)]);
          if (this.animationTrack_ > 1) {
            this.animationTrack_ = u8(this.animationTrack_ - 1);
            this.rebuildCombinedMask();
            return;
          }

          this.animationTrack_ = 0;
          this.rebuildCombinedMask();
          this.stopAnimation();
          return;

        case Animation.COUNT_DOWN_WARNING:
          if (this.warningSwirlTogglesRemaining_ > 0) {
            this.warningSwirlPhase_ = !this.warningSwirlPhase_;
            this.swirlEnabled_ = this.warningSwirlPhase_;
            --this.warningSwirlTogglesRemaining_;
            this.rebuildCombinedMask();

            if (this.warningSwirlTogglesRemaining_ === 0) {
              this.swirlEnabled_ = false;
              this.rebuildCombinedMask();
              this.stopAnimation();
            }
            return;
          }

          if (this.warningBlinkTogglesRemaining_ > 0 && this.animationTrack_ >= 1) {
            this.trackMask_ ^= this.trackMaskByIndex_[toIndex(this.animationTrack_)];
            --this.warningBlinkTogglesRemaining_;
            this.rebuildCombinedMask();

            if (this.warningBlinkTogglesRemaining_ === 0) {
              this.trackMask_ &= not64(this.trackMaskByIndex_[toIndex(this.animationTrack_)]);
              this.rebuildCombinedMask();

              if (this.animationTrack_ > 1) {
                this.animationTrack_ = u8(this.animationTrack_ - 1);
                this.warningBlinkTogglesRemaining_ = this.warningBlinkToggles;
              } else {
                this.warningSwirlPhase_ = true;
                this.warningSwirlTogglesRemaining_ = 10;
              }
            }
          }
          return;

        case Animation.RANDOM_TOGGLE: {
          // C++: rand() % kTrackCount + 1
          const track = u8(NS.random(kTrackCount) + 1);
          this.trackMask_ ^= this.trackMaskByIndex_[toIndex(track)];
          this.rebuildCombinedMask();
          return;
        }

        case Animation.NONE:
        default:
          this.stopAnimation();
          return;
      }
    }

    rebuildCombinedMask() {
      let combined = this.trackMask_;
      if (this.swirlEnabled_) combined |= kSwirlMask;

      this.vfd_.andGridBits(kTrackGrid, not64(this.allTracksMask_ | kSwirlMask));
      this.vfd_.orGridBits(kTrackGrid, combined);
      this.vfd_.buildFrames();
    }

    /** @param {number} trackNumber 1-based (1..20) */
    on(trackNumber) {
      trackNumber = u8(trackNumber);
      if (this.animationRunning_) this.stopAnimation();
      if (!isValidTrackNumber(trackNumber)) return;
      this.trackMask_ |= this.trackMaskByIndex_[toIndex(trackNumber)];
      this.rebuildCombinedMask();
    }

    off(trackNumber) {
      trackNumber = u8(trackNumber);
      if (this.animationRunning_) this.stopAnimation();
      if (!isValidTrackNumber(trackNumber)) return;
      this.trackMask_ &= not64(this.trackMaskByIndex_[toIndex(trackNumber)]);
      this.rebuildCombinedMask();
    }

    toggle(trackNumber) {
      trackNumber = u8(trackNumber);
      if (this.animationRunning_) this.stopAnimation();
      if (!isValidTrackNumber(trackNumber)) return;
      this.trackMask_ ^= this.trackMaskByIndex_[toIndex(trackNumber)];
      this.rebuildCombinedMask();
    }

    onAll() {
      if (this.animationRunning_) this.stopAnimation();
      this.trackMask_ = this.allTracksMask_;
      this.rebuildCombinedMask();
    }

    offAll() {
      if (this.animationRunning_) this.stopAnimation();
      this.trackMask_ = 0n;
      this.rebuildCombinedMask();
    }

    startCountUp(stepMs = 120) { this.startAnimation(Animation.COUNT_UP, stepMs); }
    startFillUp(stepMs = 120) { this.startAnimation(Animation.FILL_UP, stepMs); }
    startCountDown(stepMs = 120) { this.startAnimation(Animation.COUNT_DOWN, stepMs); }
    startFilledDown(stepMs = 120) { this.startAnimation(Animation.FILLED_DOWN, stepMs); }
    startCountDownWarning(stepMs = 120) { this.startAnimation(Animation.COUNT_DOWN_WARNING, stepMs); }

    startRandomToggle(periodMs = 200, clearOnStart = true) {
      if (clearOnStart) this.trackMask_ = 0n;
      this.startAnimation(Animation.RANDOM_TOGGLE, periodMs);
    }

    startSwirlBlink(periodMs = 500) {
      periodMs = u32(periodMs);
      const half = Math.floor(periodMs / 2);
      this.swirlBlinkHalfPeriodMs_ = (half === 0) ? 1 : half;
      this.swirlBlinkRunning_ = true;
      this.lastSwirlBlinkTime_ = 0;
      this.swirlEnabled_ = true;
      this.rebuildCombinedMask();
    }

    stopSwirlBlink() {
      this.swirlBlinkRunning_ = false;
    }

    stopAnimation() {
      this.animationRunning_ = false;
      this.currentAnimation_ = Animation.NONE;
      this.animationFlashTogglesRemaining_ = 0;
      this.warningBlinkTogglesRemaining_ = 0;
      this.warningSwirlTogglesRemaining_ = 0;
      this.completionSwirlTogglesRemaining_ = 0;
    }

    getState(trackNumber) {
      trackNumber = u8(trackNumber);
      if (!isValidTrackNumber(trackNumber)) return false;
      return (this.trackMask_ & this.trackMaskByIndex_[toIndex(trackNumber)]) !== 0n;
    }

    getCount() {
      let count = 0;
      let value = this.trackMask_;
      while (value !== 0n) { count += Number(value & 1n); value >>= 1n; }
      return u8(count);
    }

    getSwirlState() { return this.swirlEnabled_; }
    getCurrentAnimation() { return this.currentAnimation_; }
    isAnimationRunning() { return this.animationRunning_; }

    swirlOn() {
      if (this.animationRunning_) this.stopAnimation();
      this.swirlEnabled_ = true;
      this.rebuildCombinedMask();
    }

    swirlOff() {
      if (this.animationRunning_) this.stopAnimation();
      this.swirlEnabled_ = false;
      this.rebuildCombinedMask();
    }

    setSwirl(enabled) {
      if (this.animationRunning_) this.stopAnimation();
      this.swirlEnabled_ = !!enabled;
      this.rebuildCombinedMask();
    }
  }

  TrackService.kTrackCount = kTrackCount;
  TrackService.Animation = Animation;

  NS.TrackService = TrackService;
})(typeof window !== 'undefined' ? window : globalThis);
