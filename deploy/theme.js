/* ===========================================================================
   The theme mechanism. One copy, inlined into all three surfaces.

   This file is the source of truth. The shell and both games each inline it
   verbatim into an inline script in the head, BEFORE any stylesheet, because
   it has to run before first paint — otherwise the page renders light and then
   snaps to dark, which is the flash every themed site is judged on.

   It is deliberately tiny, dependency-free, and written in ES5 so it can sit
   in a plain inline script element in any of the three builds without a
   transpile step or a module boundary.

   WHAT IT DOES

     - Reads the player's choice from localStorage `ps:theme`. One key for the
       whole platform, because all three surfaces are one origin. Choose dark
       in Word Chain and the shell is dark when you come back to it.
     - Stamps data-theme="light" or "dark" on <html>, or removes the attribute
       for "system" so the CSS media query takes over.
     - Adds the surface class (ps-shell / sj-game / wc-game) so tokens.css
       knows which palette to serve.
     - Keeps <meta name="theme-color"> in step, so the phone's status bar
       matches the page rather than the other way round.
     - Follows the OS live while the setting is "system", via a
       prefers-color-scheme listener. Without it, a player who flips their
       phone to dark at sunset sees the page change only on reload.

   MIGRATION. Word Chain stored its theme at `wordchain:set.theme` before the
   platform existed. On first run, if `ps:theme` is unset and that older value
   exists, it is adopted so nobody loses their choice.
   =========================================================================== */

(function (global) {
  'use strict';

  var KEY = 'ps:theme';
  var LEGACY = 'wordchain:set';
  var VALID = { light: 1, dark: 1, system: 1 };

  /* Both grounds, per surface, straight from tokens.css. The status bar has to
     be told a literal colour; it cannot read a custom property. */
  var BAR = {
    'ps-shell': { light: '#C5C6C1', dark: '#3D352A' },
    'sj-game':  { light: '#F0E8DA', dark: '#0C0B0A' },
    'wc-game':  { light: '#E8D1DA', dark: '#3C2F34' }
  };

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      if (v && VALID[v]) return v;
      /* one-time adoption of Word Chain's older per-game setting */
      var old = JSON.parse(localStorage.getItem(LEGACY) || '{}');
      if (old && old.theme && VALID[old.theme]) {
        try { localStorage.setItem(KEY, old.theme); } catch (e) {}
        return old.theme;
      }
    } catch (e) {}
    /* Light is the default. Following the OS by default meant one account
       saw a light desktop and a dark phone with no way to say which it
       wanted; "system" is now something you choose, not a default. */
    return 'light';
  }

  function write(v) {
    try { localStorage.setItem(KEY, v); } catch (e) {}
  }

  /* What the page is actually showing right now, which is not the same thing
     as what the player chose: "system" resolves to one or the other. */
  function resolved(choice) {
    if (choice === 'light' || choice === 'dark') return choice;
    try {
      return global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) { return 'light'; }
  }

  function apply(choice, surface) {
    var el = document.documentElement;
    if (choice === 'system') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', choice);
    if (surface && !el.classList.contains(surface)) el.classList.add(surface);

    var pal = BAR[surface || currentSurface()];
    if (pal) {
      var m = document.querySelector('meta[name="theme-color"]');
      if (!m) {
        m = document.createElement('meta');
        m.setAttribute('name', 'theme-color');
        (document.head || el).appendChild(m);
      }
      m.setAttribute('content', pal[resolved(choice)]);
    }
    return choice;
  }

  function currentSurface() {
    var c = document.documentElement.className || '';
    if (c.indexOf('ps-shell') > -1) return 'ps-shell';
    if (c.indexOf('sj-game') > -1) return 'sj-game';
    if (c.indexOf('wc-game') > -1) return 'wc-game';
    return null;
  }

  var listeners = [];

  var Theme = {
    /* Call once, as the first thing in <head>. `surface` is one of
       'ps-shell' | 'sj-game' | 'wc-game'. */
    init: function (surface) {
      var choice = read();
      apply(choice, surface);
      /* Track the OS while the choice is "system". Safari before 14 has only
         addListener, hence the fallback. */
      try {
        var mq = global.matchMedia('(prefers-color-scheme: dark)');
        var onChange = function () {
          if (read() !== 'system') return;
          apply('system', surface);
          notify();
        };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
      } catch (e) {}
      return choice;
    },

    /* The player's choice: 'light' | 'dark' | 'system'. */
    get: read,

    /* What is on screen: 'light' | 'dark'. */
    resolved: function () { return resolved(read()); },

    set: function (v) {
      if (!VALID[v]) return read();
      write(v);
      apply(v, currentSurface());
      notify();
      return v;
    },

    /* Fires whenever the rendered theme changes, from either a click here or
       the OS changing under a "system" setting. Canvas that has painted its
       own colours — a share card, a globe overlay — should redraw on this. */
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },

    /* Wire a three-button segmented control. Each button carries
       data-theme="light|dark|system". Keeps aria-pressed honest. */
    bindControl: function (el) {
      if (!el) return;
      var paint = function () {
        var cur = read();
        for (var i = 0; i < el.children.length; i++) {
          var b = el.children[i];
          b.setAttribute('aria-pressed', b.getAttribute('data-theme') === cur ? 'true' : 'false');
        }
      };
      el.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-theme]') : null;
        if (!b || !el.contains(b)) return;
        Theme.set(b.getAttribute('data-theme'));
        paint();
      });
      listeners.push(paint);
      paint();
    }
  };

  function notify() {
    var r = resolved(read());
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](r); } catch (e) {}
    }
  }

  global.PSTheme = Theme;
})(typeof window !== 'undefined' ? window : this);
