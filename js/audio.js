/* ============================================================
 * audio.js —— Web Audio API 实时合成音效
 * 所有声音均在本地合成，不加载任何外部文件。
 * ============================================================ */

(function (global) {
  'use strict';

  var SDT = global.SDT = global.SDT || {};
  var ctx = null;
  var soundEnabled = true;
  var noiseBuffer = null;

  function ensureCtx() {
    if (!soundEnabled) return null;

    try {
      var AudioCtor = global.AudioContext || global.webkitAudioContext;
      if (!AudioCtor) return null;
      if (!ctx) ctx = new AudioCtor();
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      return ctx;
    } catch (err) {
      return null;
    }
  }

  function setEnabled(enabled) {
    soundEnabled = !!enabled;
    if (!soundEnabled && ctx && ctx.suspend) {
      try { ctx.suspend(); } catch (err) { /* 忽略浏览器限制 */ }
    }
  }

  function envelope(t0, attack, decay, peak) {
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    return g;
  }

  function oscillator(type, frequency, t0, duration, peak, filter) {
    if (!soundEnabled || !ctx) return;
    var osc = ctx.createOscillator();
    var gain = envelope(t0, Math.min(0.018, duration * 0.22), duration * 0.82, peak);
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, t0);
    osc.connect(gain);

    if (filter) {
      filter.connect(gain);
      gain.connect(ctx.destination);
      osc.disconnect();
      osc.connect(filter);
    } else {
      gain.connect(ctx.destination);
    }

    osc.start(t0);
    osc.stop(t0 + duration + 0.06);
    return { osc: osc, gain: gain };
  }

  function makeNoiseBuffer() {
    if (noiseBuffer || !ctx) return noiseBuffer;
    var length = Math.floor(ctx.sampleRate * 0.6);
    noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
    var data = noiseBuffer.getChannelData(0);
    for (var i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return noiseBuffer;
  }

  function click() {
    if (!soundEnabled || !ensureCtx()) return;
    var t0 = ctx.currentTime;
    var sound = oscillator('square', 220, t0, 0.06, 0.15);
    if (!sound) return;
    sound.osc.frequency.exponentialRampToValueAtTime(110, t0 + 0.055);
  }

  function scan() {
    if (!soundEnabled || !ensureCtx()) return;
    try {
      var t0 = ctx.currentTime;
      var src = ctx.createBufferSource();
      var filter = ctx.createBiquadFilter();
      var gain = envelope(t0, 0.025, 0.41, 0.06);
      src.buffer = makeNoiseBuffer();
      filter.type = 'bandpass';
      filter.Q.value = 1.8;
      filter.frequency.setValueAtTime(400, t0);
      filter.frequency.exponentialRampToValueAtTime(2400, t0 + 0.45);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      src.start(t0);
      src.stop(t0 + 0.5);
    } catch (err) { /* 忽略音频节点失败 */ }
  }

  function correct() {
    if (!soundEnabled || !ensureCtx()) return;
    try {
      var t0 = ctx.currentTime;
      [
        { f: 660, start: 0, duration: 0.09 },
        { f: 880, start: 0.09, duration: 0.12 }
      ].forEach(function (note) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        var n0 = t0 + note.start;
        var n1 = n0 + note.duration;
        osc.type = 'sine';
        osc.frequency.setValueAtTime(note.f, n0);
        gain.gain.setValueAtTime(0.0001, n0);
        gain.gain.exponentialRampToValueAtTime(0.12, n0 + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, n1);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(n0);
        osc.stop(n1 + 0.03);
      });
    } catch (err) { /* 忽略音频节点失败 */ }
  }

  function wrong() {
    if (!soundEnabled || !ensureCtx()) return;
    try {
      var t0 = ctx.currentTime;
      var filter = ctx.createBiquadFilter();
      var osc = ctx.createOscillator();
      var gain = envelope(t0, 0.015, 0.26, 0.14);
      filter.type = 'lowpass';
      filter.frequency.value = 800;
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(180, t0);
      osc.frequency.exponentialRampToValueAtTime(90, t0 + 0.27);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.33);
    } catch (err) { /* 忽略音频节点失败 */ }
  }

  function alarm() {
    if (!soundEnabled || !ensureCtx()) return;
    try {
      var t0 = ctx.currentTime;
      var osc = ctx.createOscillator();
      var lfo = ctx.createOscillator();
      var lfoGain = ctx.createGain();
      var gain = envelope(t0, 0.025, 0.45, 0.1);
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(440, t0);
      lfo.type = 'sine';
      lfo.frequency.value = 6;
      lfoGain.gain.value = 35;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      lfo.start(t0);
      osc.stop(t0 + 0.52);
      lfo.stop(t0 + 0.52);
    } catch (err) { /* 忽略音频节点失败 */ }
  }

  function heartbeat() {
    if (!soundEnabled || !ensureCtx()) return;
    var t0 = ctx.currentTime;
    var sound = oscillator('sine', 55, t0, 0.14, 0.25);
    if (!sound) return;
    sound.osc.frequency.exponentialRampToValueAtTime(48, t0 + 0.13);
  }

  function timeout() {
    if (!soundEnabled || !ensureCtx()) return;
    try {
      var t0 = ctx.currentTime;
      var osc = ctx.createOscillator();
      var shaper = ctx.createWaveShaper();
      var gain = envelope(t0, 0.02, 0.46, 0.1);
      var curve = new Float32Array(256);
      for (var i = 0; i < curve.length; i++) {
        var x = i / (curve.length - 1) * 2 - 1;
        curve[i] = Math.tanh(x * 2.6) * 0.72;
      }
      shaper.curve = curve;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(300, t0);
      osc.frequency.exponentialRampToValueAtTime(120, t0 + 0.48);
      osc.connect(shaper);
      shaper.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.55);
    } catch (err) { /* 忽略音频节点失败 */ }
  }

  SDT.audio = {
    ensureCtx: ensureCtx,
    setEnabled: setEnabled,
    click: click,
    scan: scan,
    correct: correct,
    wrong: wrong,
    alarm: alarm,
    heartbeat: heartbeat,
    timeout: timeout
  };

})(window);
