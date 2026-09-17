/* ===========================================================================
   PlaySapien UI behaviour — the half of the chrome that is not CSS.

   Sheets and toasts, which every game reimplemented. Sojourner had TWO
   parallel sheet systems (closeSheets for in-game sheets, openPanel/closePanels
   for the corner panels); Word Chain had one; the shell had a third. All three
   did the same thing, and none of them trapped focus, so a keyboard user could
   tab straight past the scrim into the page behind.

   ES5, dependency-free, no build step, ~120 lines. Inlined verbatim into every
   surface after ui.css; check-inline.mjs fails the build if a copy drifts.

   USAGE

     PSUI.init({ sheets: ['aboutSheet','settingsSheet'], scrim: 'scrim',
                 toast: 'toast' });
     PSUI.open('aboutSheet');
     PSUI.open('confirmSheet', { stack: true });   // over the one already open
     PSUI.open('revealSheet',  { scrim: false });  // do not dim what is behind
     PSUI.close();        // closes the topmost only
     PSUI.closeAll();
     PSUI.toast('Copied');

   Escape and a scrim click close the TOPMOST sheet. Focus moves into it on
   open and returns to whatever opened it on close.

   Two options exist because both games needed them the moment they adopted
   this file:

     stack   Word Chain asks "Delete this chain?" from inside an open sheet.
             Without a stack, the confirm and the sheet fight over Escape and
             the focus trap drags Tab back into the sheet underneath.
     scrim   Sojourner's round reveal flies the globe to the answer. Dimming
             and blocking the globe at exactly the moment the player is looking
             at it is the wrong behaviour, and it was a regression the first
             time this file did not offer the choice.
   =========================================================================== */

(function (global) {
  'use strict';

  var sheetIds = [];
  var scrimEl = null;
  var toastEl = null;
  var toastTimer = null;
  var closers = [];
  /* Open sheets, innermost last. Each entry: {id, scrim, focus} where `focus`
     is whatever had focus when it opened, so closing restores in reverse. */
  var stack = [];

  function $(id) { return document.getElementById(id); }

  /* The topmost open sheet -- what Escape closes and what traps focus. */
  function openId() { return stack.length ? stack[stack.length - 1].id : null; }
  function isOpen(id) {
    for (var i = 0; i < stack.length; i++) if (stack[i].id === id) return true;
    return false;
  }
  function wantsScrim() {
    for (var i = 0; i < stack.length; i++) if (stack[i].scrim) return true;
    return false;
  }

  /* Everything in the sheet a keyboard can reach, in document order, skipping
     anything currently hidden. Recomputed on each Tab because a sheet's
     contents change -- the sign-in sheet swaps an email form for a code form. */
  function focusables(el) {
    var all = el.querySelectorAll(
      'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]),' +
      'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (n.offsetWidth || n.offsetHeight || n.getClientRects().length) out.push(n);
    }
    return out;
  }

  function open(id, opts) {
    var target = $(id);
    if (!target) return;
    opts = opts || {};
    if (isOpen(id)) return;

    /* Without {stack:true} this replaces whatever is open, which is what a
       plain sheet switch wants. With it, the new sheet sits on top. */
    if (!opts.stack) hideAll();

    stack.push({ id: id, scrim: opts.scrim !== false, focus: document.activeElement });
    target.hidden = false;
    /* Raise each stacked layer above the one below, from the same base the
       stylesheet uses, so a game does not have to hand-manage z-index. */
    if (stack.length > 1) target.style.zIndex = String(baseZ() + stack.length * 2);
    else target.style.removeProperty('z-index');
    /* One frame between unhiding and adding .on, or the browser has nothing to
       transition from and the sheet simply appears. */
    if (global.requestAnimationFrame) global.requestAnimationFrame(function () { target.classList.add('on'); });
    else target.classList.add('on');

    if (scrimEl) {
      if (wantsScrim()) {
        scrimEl.classList.add('on');
        scrimEl.style.zIndex = stack.length > 1 ? String(baseZ() + stack.length * 2 - 1) : '';
      } else {
        scrimEl.classList.remove('on');
      }
    }
    /* Focus the first real control rather than the dialog itself: a screen
       reader then reads the heading and lands somewhere useful. */
    setTimeout(function () {
      var f = focusables(target);
      if (f.length) f[0].focus();
      else { target.setAttribute('tabindex', '-1'); target.focus(); }
    }, 60);
  }

  function baseZ() {
    var v = parseInt(getVar('--sheet-z'), 10);
    return isNaN(v) ? 31 : v;
  }

  function lower(el) {
    if (!el) return;
    el.classList.remove('on');
    /* Wait for the slide-out before hiding, or it vanishes mid-animation.
       Guarded, because it may have been reopened in the meantime. */
    setTimeout(function () {
      if (!el.classList.contains('on')) { el.hidden = true; el.style.removeProperty('z-index'); }
    }, 440);
  }

  function hideAll() {
    while (stack.length) {
      var top = stack.pop();
      lower($(top.id));
    }
  }

  /* Closes the TOPMOST sheet only, which is what Escape and a scrim tap mean
     when a confirm is sitting over a sheet. */
  function close() {
    var top = stack.pop();
    if (!top) return;
    var el = $(top.id), was = top.id;
    lower(el);
    if (scrimEl) {
      if (wantsScrim()) scrimEl.style.zIndex = stack.length > 1 ? String(baseZ() + stack.length * 2 - 1) : '';
      else { scrimEl.classList.remove('on'); scrimEl.style.removeProperty('z-index'); }
    }
    if (top.focus && top.focus.focus) top.focus.focus();
    for (var j = 0; j < closers.length; j++) { try { closers[j](was); } catch (e) {} }
  }

  function closeAll() { while (stack.length) close(); }

  function toast(msg, ms) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); },
                            ms || Number(getVar('--toast-ms')) || 2200);
  }

  function getVar(name) {
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
    catch (e) { return ''; }
  }

  var UI = {
    /* Point the bar's brand link at the right place for this surface. Safe to
       call more than once and safe on a page with no bar. */
    bar: bar,
    init: function (opts) {
      opts = opts || {};
      sheetIds = opts.sheets || [];
      bar();                       /* every surface with a bar wants this */
      scrimEl = opts.scrim ? $(opts.scrim) : null;
      toastEl = opts.toast ? $(opts.toast) : null;

      if (scrimEl) scrimEl.addEventListener('click', close);

      document.addEventListener('keydown', function (e) {
        var id = openId();
        if (!id) return;
        if (e.key === 'Escape') { e.preventDefault(); close(); return; }
        if (e.key !== 'Tab') return;
        var f = focusables($(id));
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      });

      /* Anything with data-sheet="fooSheet" opens that sheet; anything with
         data-sheet-close closes. Saves a listener per button in every game. */
      document.addEventListener('click', function (e) {
        var t = e.target.closest ? e.target.closest('[data-sheet],[data-sheet-close]') : null;
        if (!t) return;
        if (t.hasAttribute('data-sheet-close')) { e.preventDefault(); close(); }
        else {
          e.preventDefault();
          open(t.getAttribute('data-sheet'), {
            stack: t.hasAttribute('data-sheet-stack'),
            scrim: !t.hasAttribute('data-sheet-noscrim')
          });
        }
      });
      return UI;
    },
    open: open,
    close: close,
    closeAll: closeAll,
    openId: openId,
    isOpen: isOpen,
    depth: function () { return stack.length; },
    toast: toast,
    /* Called after each close with the id that closed, so a game can resync. */
    onClose: function (fn) { if (typeof fn === 'function') closers.push(fn); }
  };

  /* The bar's brand link. One markup for every surface, so where it points is
     decided here rather than by each surface shipping a different href:
     on the shell it is the About page (the same place the About icon goes),
     and inside a game it is the way back out to the front door. */
  function bar() {
    var a = document.getElementById('psbarBrand');
    if (!a) return;
    var shell = document.documentElement.classList.contains('ps-shell');
    a.setAttribute('href', shell ? '/about/' : '/');
    a.setAttribute('aria-label', shell ? 'About PlaySapien' : 'PlaySapien home');

    /* Analytics: one sheet, wired once here, so no surface has to remember to do
       it and none of them can forget. What it will eventually show differs, so
       the copy does too. */
    var sb = document.getElementById('statsBtn'), body = document.getElementById('statsBody');
    if (body) {
      body.textContent = shell
        ? 'This will show how you are doing across every game, and the leaderboards for all of them. It is not built yet.'
        : 'This will show this game\u2019s leaderboards and how your past rounds have gone. It is not built yet.';
    }
    if (sb && !sb.__wired) {
      sb.__wired = true;
      sb.addEventListener('click', function () { UI.open('statsSheet'); });
    }

    /* Add. Only the shell is wired here — in a game this button is that game's
       own "make a puzzle" control and the game binds it itself. */
    var ab = document.getElementById('addBtn');
    if (shell && ab && !ab.__wired) {
      ab.__wired = true;
      ab.addEventListener('click', function () { UI.open('addSheet'); });
    }
  }

  global.PSUI = UI;
})(typeof window !== 'undefined' ? window : this);
