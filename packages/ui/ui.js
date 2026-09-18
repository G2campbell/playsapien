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
    attnStop: attnStop,
    avatar: avatar,
    avatarTokens: avatarTokens,
    setAvatar: setAvatar,
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

  /* ------------------------------------------------------------ avatars ----
     One renderer, shared by the profile screen that PICKS an avatar and the
     bar that WEARS it, on every surface. Two copies of this would drift the
     first time a colour changed, and the drift would show as the same person
     looking like two people on two screens of the same app.

     A preset is drawn, not fetched: the crest is already on the page as the
     <symbol id="psmark"> sprite, so a preset is that symbol on a coloured
     disc, recoloured through currentColor and --mk-w. No image request, no
     file to ship, and it themes itself.

     A custom picture is a data: url the player uploaded, already cropped
     square and downscaled by the browser before it was ever sent. It is drawn
     in a round frame with object-fit:cover, so a square source is
     circle-cropped rather than squashed.

     The fallback, for a player with neither, is their initial. */
  var AV_INK = [
    ['#213946', '#C5C6C1'],   /* platform ink on paper      */
    ['#5A7085', '#EDE7DC'],   /* the proof's steel foil     */
    ['#3F5569', '#C5C6C1'],
    ['#2F434C', '#9D8D85'],
    ['#8E3A5A', '#F0E0E7'],   /* Word Chain                 */
    ['#E0A44A', '#2A1F12'],   /* Sojourner                  */
    ['#325843', '#E3EDE6'],
    ['#863921', '#F3E3DC'],
  ];
  var AV_COUNT = AV_INK.length;

  function avatarTokens() {
    var out = [], i;
    for (i = 1; i <= AV_COUNT; i++) out.push('ps-' + (i < 10 ? '0' : '') + i);
    return out;
  }

  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* The disc, as markup. `user` may be null (signed out) or a partial record.
     Returns a string so it can go straight into innerHTML at any size -- the
     caller sizes the box; this always fills it. */
  function avatar(user, opts) {
    var o = opts || {};
    var token = user && user.avatar ? String(user.avatar) : '';
    var img = user && user.avatar_img ? String(user.avatar_img) : '';
    var label = o.label || '';

    /* A custom picture wins only when the token says so. The token is the one
       source of truth for WHICH avatar is in use, so a leftover upload cannot
       quietly override a preset the player has since chosen. */
    if (token === 'custom' && /^data:image\/(png|jpeg|webp);base64,/.test(img)) {
      return '<img class="psav-img" src="' + escapeAttr(img) + '" alt="' +
             escapeAttr(label) + '">';
    }

    var m = /^ps-(\d{2})$/.exec(token);
    if (m) {
      var pair = AV_INK[(parseInt(m[1], 10) - 1) % AV_COUNT];
      /* The nested <svg> is how the 1132x595 crest gets placed inside a square
         disc without distorting: the inner viewBox keeps its own aspect ratio
         and the outer one only says where to put it. */
      return '<svg class="psav-svg" viewBox="0 0 100 100" aria-hidden="true">' +
             '<circle cx="50" cy="50" r="50" fill="' + pair[0] + '"/>' +
             '<svg x="17" y="32.6" width="66" height="34.7" viewBox="0 0 1132 595" ' +
               'style="color:' + pair[1] + ';--mk-w:70">' +
               '<use href="#psmark"/></svg>' +
             '</svg>';
    }

    var initial = (user && (user.display_name || user.email) || '?').trim().charAt(0).toUpperCase();
    return '<span class="psav-ltr" aria-hidden="true">' + escapeAttr(initial || '?') + '</span>';
  }

  /* ---------------------------------------------------- the first minute ----
     The profile button is the only control on the bar that leads anywhere a
     visitor has a reason to go, and it looks like every other icon beside it.
     So for one minute it breathes -- hollow to solid blue and back -- and then
     stops.

     Four rules about when it does NOT run, each of them the difference between
     a hint and a nag:

       - Once it has been clicked, ever. Remembered across visits, because the
         message is "there is something here", and that message has landed the
         moment someone opens it. Repeating it afterwards is just a flashing
         icon on a page about puzzles.
       - When the player is wearing an avatar. Pulsing somebody's own face at
         them is not a hint, it is a glitch.
       - After a minute. A pulse with no end stops reading as a pointer and
         starts reading as something broken.
       - When browser storage is unavailable -- a private window, blocked site
         data. Then it runs for this page and is simply not remembered, which
         is a worse experience than remembering and a much better one than
         throwing on a read that was never essential.

     Sixty seconds is also long enough to survive a page that takes a moment to
     settle, and short enough that nobody who ignored it sits through it twice
     on the same visit. */
  var ATTN_KEY = 'ps:seen-profile';
  var ATTN_MS = 60000;

  function attnSeen() {
    try { return localStorage.getItem(ATTN_KEY) === '1'; } catch (e) { return false; }
  }
  function attnStop(remember) {
    var b = document.getElementById('profileBtn');
    if (b) b.classList.remove('attn');
    if (remember) { try { localStorage.setItem(ATTN_KEY, '1'); } catch (e) { /* fine */ } }
  }
  function attnStart() {
    var b = document.getElementById('profileBtn');
    if (!b || b.__attn || attnSeen()) return;
    if (b.classList.contains('has-av')) return;     // they already have a face
    b.__attn = true;
    b.classList.add('attn');
    /* Stop on the first press, whatever opens as a result -- the button's own
       handler belongs to the surface, and this must not depend on any of them
       having remembered to call it. */
    b.addEventListener('click', function () { attnStop(true); }, { once: true });
    setTimeout(function () { attnStop(false); }, ATTN_MS);
  }

  /* Swap the bar's profile button between the generic outline person and the
     player's own face. Called with null on sign-out, which puts the icon back
     -- a bar still showing yesterday's face after signing out is a bug people
     read as "it did not sign me out". */
  function setAvatar(user) {
    var b = document.getElementById('profileBtn');
    if (!b) return;
    if (b.__icon == null) b.__icon = b.innerHTML;      // keep the original once
    var on = !!(user && (user.avatar || user.avatar_img));
    b.classList.toggle('has-av', on);
    b.innerHTML = on ? avatar(user, { label: 'Your profile' }) : b.__icon;
    /* A face arriving ends the pulse, and remembers it: someone with an avatar
       has plainly found the button already. It is also a correctness fix
       rather than only a nicety -- the animation targets the SVG's children,
       and replacing the button's contents with an <img> leaves the class on
       with nothing to animate. */
    if (on) attnStop(true);

    /* A Sapien subscriber never sees it. The pulse exists to point at an
       account and, past that, at the paid option -- both of which they already
       have, so to them it is an advertisement for something they are paying
       for. Stopped WITHOUT remembering, so the suppression follows the plan:
       if they ever come back down to Free the nudge is available again,
       subject to every other rule that governs it. */
    if (user && user.plan === 'sapien') attnStop(false);
  }

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

    /* The face in the bar. The shell already loads the account layer and calls
       setAvatar itself with a fuller record, so it is left alone; a GAME has no
       account layer at all — both games are entirely local — and would
       otherwise show the generic icon to a signed-in player, which reads as
       having been signed out by walking into a game.

       So the bar asks for itself: one cookie'd GET, once per load, and silence
       if anything at all goes wrong. Nothing here is allowed to affect a game
       that is working perfectly well without it. */
    /* Last, so a surface that is about to paint a real avatar has had its
       chance: attnStart bails out on a button already wearing one. */
    attnStart();

    if (!shell && typeof fetch === 'function' && !bar.__asked) {
      bar.__asked = true;
      try {
        fetch('/api/auth/session', { credentials: 'include', headers: { Accept: 'application/json' } })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            var u = j && j.data && j.data.user;
            if (u) setAvatar(u);
          })
          .catch(function () { /* offline, or no backend: keep the icon */ });
      } catch (e) { /* no fetch, ancient browser: keep the icon */ }
    }
  }

  global.PSUI = UI;
})(typeof window !== 'undefined' ? window : this);
