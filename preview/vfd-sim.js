// Preview simulator: wires the ported services + SequenceEngine together the same way
// src/main.cpp does, drives them from a simulated millis() clock, and paints a Display.
(function (G) {
  'use strict';
  const NS = G.VFDSim = G.VFDSim || {};

  const STEP_MS = 1;            // firmware loop() runs roughly every millisecond
  const MAX_FRAME_SIM_MS = 250; // cap catch-up work after a stalled tab

  class Simulator {
    constructor(display) {
      this.display = display;
      this.mic = new NS.MicService();
      this.mic.begin();
      this.speed = 1;
      this.loop = false;
      this.playing = false;
      this.seqJson = null;
      this.simMs = 0;
      this.completed = false;
      this.listeners = [];
      this._raf = 0;
      this._lastWall = 0;
      this.reset();
    }

    onTick(fn) { this.listeners.push(fn); }

    // Fresh, blank device state (services initialised, nothing enabled).
    reset() {
      this.simMs = 0;
      NS.setMillis(0);
      NS.Fonts.setActive(1); // firmware default (setup(): Fonts::setActive(1))
      const vfd = this.vfd = new NS.VfdDriver();
      vfd.begin();
      this.eq = new NS.EqService(vfd);
      this.icons = new NS.IconService(vfd);
      this.track = new NS.TrackService(vfd);
      this.disc = new NS.DiscService(vfd);
      this.topBar = new NS.TopBarService(vfd);
      this.text = new NS.TextService(vfd);
      this.counter = new NS.NumberCounterService(vfd);
      if (this.eq.setMicSource) this.eq.setMicSource(this.mic);
      this.eq.init();
      this.icons.init();
      this.track.init();
      this.disc.init();
      this.topBar.init();
      this.text.init();
      this.counter.init();
      if (NS.resetClockBase) NS.resetClockBase();
      this.clock = NS.ClockService ? new NS.ClockService(vfd, this.icons) : null;
      this.engine = new NS.SequenceEngine(vfd, this.eq, this.icons, this.track, this.disc,
                                          this.topBar, this.text, this.counter);
      if (this.clock) this.engine.setClockService(this.clock);
      this.completed = false;
      this.display.render(vfd);
      this._emit();
    }

    setSequence(obj) { this.seqJson = obj; }

    // Restart from a blank display and run the current sequence.
    // startStep (0-based): begin at that step, with earlier steps' actions
    // applied instantly (see SequenceEngine.skipTo).
    play(startStep = 0) {
      this.stop(false);
      this.reset();
      if (!this.seqJson) return false;
      let ok = this.engine.startSequence(JSON.stringify(this.seqJson), true);
      if (ok && startStep > 0) ok = this.engine.skipTo(startStep);
      this.startStep = ok ? startStep : 0;
      this._afterEngineStep();
      this.playing = true;
      this._lastWall = performance.now();
      this._raf = requestAnimationFrame((t) => this._frame(t));
      this._emit();
      return ok;
    }

    pause() {
      if (!this.playing) return;
      this.playing = false;
      cancelAnimationFrame(this._raf);
      this._emit();
    }

    resume() {
      if (this.playing) return;
      this.playing = true;
      this._lastWall = performance.now();
      this._raf = requestAnimationFrame((t) => this._frame(t));
      this._emit();
    }

    stop(blank = true) {
      this.playing = false;
      cancelAnimationFrame(this._raf);
      if (this.engine) this.engine.stopSequence();
      if (blank) this.reset();
      else this._emit();
    }

    // Advance simulated time by `ms`, ticking the firmware loop order.
    advance(ms) {
      const end = this.simMs + ms;
      while (this.simMs < end) {
        this.simMs += STEP_MS;
        const now = this.simMs >>> 0;
        NS.setMillis(now);
        this.engine.update(now);
        this._afterEngineStep();
        this.text.update(now);
        this.counter.update(now);
        if (this.clock) this.clock.update(now);
        this.mic.update(now);
        this.eq.update(now);
        // track.anim notif_count: the preview's notification count is the test "count".
        if (this.track.isNotifCountShown())
          this.track.setNotifCount((NS.tokenContext && NS.tokenContext.count) || 0);
        this.track.update(now);
        this.disc.update(now);
        this.topBar.update(now);
      }
      this.display.render(this.vfd);
    }

    _afterEngineStep() {
      if (this.completed || this.engine.isSequenceRunning()) return;
      this.completed = true;
      if (this.loop && this.seqJson && !this.engine.lastError()) {
        // Re-run on top of the current state, like sending RUN again on the device.
        this.engine.startSequence(JSON.stringify(this.seqJson), true);
        this.completed = false;
      }
    }

    _frame(t) {
      if (!this.playing) return;
      const wall = Math.min(t - this._lastWall, MAX_FRAME_SIM_MS);
      this._lastWall = t;
      const ms = Math.max(0, Math.round(wall * this.speed));
      if (ms > 0) this.advance(ms);
      this._emit();
      this._raf = requestAnimationFrame((tt) => this._frame(tt));
    }

    // Press a cuff button in the preview. Returns true if the sequence took it.
    input(name) {
      const ok = this.engine ? this.engine.handleInput(name) : false;
      this._emit();
      return ok;
    }

    status() {
      const e = this.engine;
      return {
        waiting: e ? e.isWaitingForInput() : false,
        waitInputs: e ? e.waitInputs() : [],
        waitRemainingMs: e ? e.waitRemainingMs(this.simMs >>> 0) : 0,
        waitStep: e ? e.waitStepIndex() : -1,
        inputStep: e ? e.inputStepIndex() : -1,
        endReason: e ? e.lastEndReason() : '',
        playing: this.playing,
        timeMs: this.simMs,
        running: e ? e.isSequenceRunning() : false,
        completed: this.completed,
        error: e ? e.lastError() : '',
        failedStep: e ? e.lastFailedStepIndex() : -1,
        failedKind: e ? e.lastFailedActionKind() : '',
        nextStep: e && e.nextStepIndex ? e.nextStepIndex() : -1,
      };
    }

    _emit() { const s = this.status(); for (const fn of this.listeners) fn(s); }
  }

  NS.Simulator = Simulator;
})(typeof window !== 'undefined' ? window : globalThis);
