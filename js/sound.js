/* Page-turn sound: a short synthesized paper swish (Web Audio), or a recorded file if configured. */
window.PageSound = (function () {
  'use strict';

  var ctx = null;
  var noiseBuffer = null;
  var enabled = true;
  var fileAudio = null;
  var lastPlay = 0;

  function context() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function noise(c) {
    if (noiseBuffer) return noiseBuffer;
    var length = Math.floor(c.sampleRate * 0.6);
    noiseBuffer = c.createBuffer(1, length, c.sampleRate);
    var data = noiseBuffer.getChannelData(0);
    // Slightly "grainy" noise sounds more like paper than pure white noise.
    var last = 0;
    for (var i = 0; i < length; i++) {
      var white = Math.random() * 2 - 1;
      last = last * 0.6 + white * 0.4;
      data[i] = Math.random() < 0.002 ? white : last;
    }
    return noiseBuffer;
  }

  function synth() {
    var c = context();
    if (!c) return;
    var t = c.currentTime + 0.01;
    var dur = 0.42 + Math.random() * 0.08;

    var src = c.createBufferSource();
    src.buffer = noise(c);
    src.playbackRate.value = 0.85 + Math.random() * 0.3;

    var band = c.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 0.7;
    band.frequency.setValueAtTime(3800, t);
    band.frequency.exponentialRampToValueAtTime(650, t + dur);

    var high = c.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 280;

    var gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.5, t + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.18, t + dur * 0.55);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(band).connect(high).connect(gain).connect(c.destination);
    src.start(t);
    src.stop(t + dur + 0.05);

    // Soft "flap" as the page settles.
    var thumpAt = t + dur * 0.78;
    var osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, thumpAt);
    osc.frequency.exponentialRampToValueAtTime(55, thumpAt + 0.12);
    var og = c.createGain();
    og.gain.setValueAtTime(0.0001, thumpAt);
    og.gain.exponentialRampToValueAtTime(0.22, thumpAt + 0.015);
    og.gain.exponentialRampToValueAtTime(0.0001, thumpAt + 0.14);
    osc.connect(og).connect(c.destination);
    osc.start(thumpAt);
    osc.stop(thumpAt + 0.16);
  }

  function play() {
    if (!enabled) return;
    var now = Date.now();
    if (now - lastPlay < 120) return;
    lastPlay = now;
    if (fileAudio) {
      var a = fileAudio.cloneNode();
      a.volume = 0.8;
      a.play().catch(function () {});
    } else {
      synth();
    }
  }

  return {
    play: play,
    unlock: context,
    useFile: function (src) {
      if (src) { fileAudio = new Audio(src); fileAudio.preload = 'auto'; }
    },
    setEnabled: function (on) { enabled = !!on; },
    isEnabled: function () { return enabled; }
  };
})();
