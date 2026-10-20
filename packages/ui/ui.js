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
    if (id === 'payWall') paintPayWall();     // the trial offer depends on who is asking
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
    /* A page that never put a toast element in its markup (the front door did
       not) still gets its messages: make one, once, at the end of the body. */
    if (!toastEl && document.body) {
      toastEl = $('toast');
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.className = 'toast'; toastEl.id = 'toast';
        toastEl.setAttribute('role', 'status'); toastEl.setAttribute('aria-live', 'polite');
        document.body.appendChild(toastEl);
      }
    }
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
    /* Ask for files to be kept for offline play: a game's data that is only
       fetched once play begins. */
    cacheForOffline: cacheForOffline,
    /* Who is signed in, for a surface that wants to ask. Resolves to the user
       record or null. */
    whenUser: whenUser,
    /* The friend groups this player belongs to, for the Analytics picker.
       [{id, name}]. Nothing calls this yet: groups do not exist in the API. */
    setFriendGroups: function (list) { GROUPS = Array.isArray(list) ? list : []; paintGroups(); },
    paintAnalytics: paintAnalytics,
    /* "1 November 2026" from a plan_until, for any surface that shows it. */
    untilText: untilText,
    /* The daily-game row: TODAY, then the days before it. */
    dayButtons: dayButtons,
    wireDayRow: wireDayRow,
    /* How many earlier days the row offers. */
    pastDays: function () { return PAST_DAYS; },
    avatar: avatar,
    avatarTokens: avatarTokens,
    setAvatar: setAvatar,
    /* Open the Friends card with an invite code already typed in (the
       front door's ?f=CODE links). */
    openFriends: function (code) {
      var i = document.getElementById('frAddIn');
      if (i && code) i.value = String(code).toUpperCase();
      loadFriends(); UI.open('friendsSheet');
    },
    /* The one call a surface makes when it learns who is signed in. */
    setUser: setUser,
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

  /* The picture sets -- Monsters, Robots, Animals -- served from /avatars/ at
     the site root (packages/avatars/<set>/, copied in by the front door's
     build). A token is "<kind>-NN"; the numbers are the files' own, gaps and
     all, so a token always names the same picture. */
  function range(a, b) {
    var out = [];
    for (var i = a; i <= b; i++) out.push(i < 10 ? '0' + i : String(i));
    return out;
  }
  var MONSTERS = ['01','02','03','04','05','06','07','08',
                  '11','12','13','14','15','16','17','18','19',
                  '21','22','23','24','25',
                  '31','32','33','34','35','36','37','38','39',
                  '41','42','43','44','45','46','47','48','49'];
  /* Each robot twice, side by side: the whole robot (NN), then a close-up of
     its head (NNb) -- a full-length figure is small inside a round frame. */
  var ROBOTS = [];
  range(1, 18).forEach(function (n) { ROBOTS.push(n, n + 'b'); });
  /* Animals carry a group letter after their number (animal-36a):
       a dogs (and foxes)   b cats, big cats    c birds
       d cows, bulls, hippos e bears, zebras, giraffes   f everything else
     The letter is what lets each player's selection include one of each. */
  var ANIMALS = ['01d','02f','03f','04f','05f','06b','07c','08c','09a','10d','11d','12b','13b','14f','15e','16e','17f','18e','19d','20d','21d','22d','23f','24f','25f','26f','27d','28c','29c','30a','31e','32a','33a','34a','35a','36a','37f','38d','39f','40c','41a','42e','43c','44d','45c','46d','47c','48f','49c','50b','51b','52e','53e','54f','55a','56b','57a','58f','59e','60f','61c','62d','63d'];
  var PICTURE_SETS = { monster: MONSTERS, robot: ROBOTS, animal: ANIMALS };

  /* ---- each player's own selection -------------------------------------
     A player is offered 8 faces from each picture set, not all of them, so
     that different players tend to look different. The 8 are drawn from a
     random-number sequence seeded by the player's id, so the same player
     always gets the same 8 -- on every device, every visit -- until DEAL
     below is changed, which deals everyone a fresh selection.

       Monsters  any 12.
       Robots    12 different robots: 6 as head close-ups (NNb), 6 whole.
       Animals   one from each group (a-f), then 6 more from the rest.

     Whatever a player is already wearing is always offered too, even after a
     new deal, so nobody loses their face by having it dealt away. */
  var DEAL = 'deal-1';                 // change this to re-deal every player
  var DEAL_SIZE = 12;                  // faces offered per picture set (even: robots split in half)
  function seeded(str) {
    var h = 2166136261;                // FNV-1a, then mulberry32
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    var a = h >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffled(list, rnd) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function dealFor(user, kind) {
    var rnd = seeded(DEAL + '|' + ((user && user.id) || 'guest') + '|' + kind);
    var pick;
    if (kind === 'robot') {
      var nums = shuffled(range(1, 18), rnd).slice(0, DEAL_SIZE);
      var half = DEAL_SIZE / 2;
      pick = nums.slice(0, half).map(function (n) { return n + 'b'; }).concat(nums.slice(half));
    } else if (kind === 'animal') {
      pick = [];
      'abcdef'.split('').forEach(function (g) {
        var inGroup = ANIMALS.filter(function (n) { return n.charAt(2) === g; });
        pick.push(inGroup[Math.floor(rnd() * inGroup.length)]);
      });
      var rest = shuffled(ANIMALS.filter(function (n) { return pick.indexOf(n) < 0; }), rnd);
      pick = pick.concat(rest.slice(0, DEAL_SIZE - pick.length));
    } else {
      pick = shuffled(PICTURE_SETS[kind], rnd).slice(0, DEAL_SIZE);
    }
    pick.sort();
    var out = pick.map(function (n) { return kind + '-' + n; });
    var wearing = user && user.avatar;
    if (wearing && wearing.indexOf(kind + '-') === 0 && out.indexOf(wearing) < 0) out.push(wearing);
    return out;
  }

  /* The Icons OFFERED: six of the eight colourings. The two dropped (03, 04)
     sat too close to 01 and 02 to be worth a choice of their own; avatar()
     still draws all eight, so anyone already wearing one keeps it. */
  var ICONS_OFFERED = ['ps-01', 'ps-02', 'ps-05', 'ps-06', 'ps-07', 'ps-08'];
  function avatarTokens() { return ICONS_OFFERED.slice(); }

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

    var mm = /^(monster|robot|animal)-(\d{2}[a-f]?)$/.exec(token);
    if (mm && PICTURE_SETS[mm[1]].indexOf(mm[2]) >= 0) {
      return '<img class="psav-img" src="/avatars/' + token + '.webp" alt="' +
             escapeAttr(label) + '" decoding="async">';
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
  /* Who is signed in has changed -- signed in, signed out, saved a new face.
     Everything that shows the player repaints from here: the bar's button,
     the who-strip on each card, the Profile card. Then the page is told, so
     a surface with its own signed-in parts (the front door's Friends) can
     follow without being called by name. */
  function setUser(user) {
    /* A profile save returns the account without the trial flag (it is worked
       out by /auth/session and /player/me); carry it over rather than lose it. */
    if (user && ME.user && user.id === ME.user.id && user.trial_available === undefined) {
      user.trial_available = ME.user.trial_available;
    }
    if (user && ME.user && user.id === ME.user.id && user.name_needed === undefined) {
      user.name_needed = ME.user.name_needed;
    }
    learnUser(user);                                   // the newest word is final
    paintBarAvatar(user);
    try { document.dispatchEvent(new CustomEvent('ps:user', { detail: user || null })); }
    catch (e) { /* very old browser: the surface repaints on its next load */ }
  }
  function setAvatar(user) { setUser(user); }        // the old name, still exported

  function paintBarAvatar(user) {
    var b = document.getElementById('profileBtn');
    if (!b) return;
    if (b.__icon == null) b.__icon = b.innerHTML;      // keep the original once
    var on = !!(user && user.avatar);
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
  /* ------------------------------------------------------------ who ----
     Who is signed in, and on which plan, known to every surface -- the front
     door, which loads the account SDK, and both games, which do not. Filled by
     whichever answers first: the bar's own /auth/session call, or the shell
     telling us through setAvatar(). Until one of them does, `known` is false
     and anything that depends on it waits rather than guessing, because
     guessing "signed out" would flash the sign-in card at someone who is not. */
  var ME = { known: false, user: null, waiters: [] };
  function learnUser(u) {
    ME.user = u || null;
    ME.known = true;
    paintWho();
    paintProfile();
    if (ME.user && UI.isOpen('profileSheet')) loadDevices();
    if (UI.isOpen('friendsSheet')) loadFriends(); else paintFriends();
    askName();
    var w = ME.waiters; ME.waiters = [];
    for (var i = 0; i < w.length; i++) { try { w[i](ME.user); } catch (e) { /* one bad waiter must not stop the rest */ } }
  }
  /* Resolves once we know. Four seconds is the ceiling: an API that has not
     answered by then is not coming, and the page should behave as signed out
     rather than hold a tapped button hostage indefinitely. */
  function whenUser() {
    return new Promise(function (res) {
      if (ME.known) { res(ME.user); return; }
      ME.waiters.push(res);
      setTimeout(function () { if (!ME.known) learnUser(null); }, 4000);
    });
  }
  function isShell() { return document.documentElement.classList.contains('ps-shell'); }
  function planOf(u) { return u && u.plan === 'sapien' ? 'sapien' : 'free'; }

  /* ------------------------------------------------------------ the gate ----
     Three kinds of player, and what each may reach:

       signed out  About, Settings, Profile, and every game's daily puzzle.
                   Analytics, Add, Friends and Friends' Games open the sign-in
                   card instead of themselves.
       free        all of the above, plus Analytics (Daily only), Friends, and
                   Friends' Games. Making a puzzle opens the upgrade instead.
       sapien      everything.

     Enforced HERE, by one capture-phase listener on the document, rather than
     by each surface checking in its own click handler. A capture listener on
     the document runs before any listener on the button itself, so a surface
     that forgets to ask -- or a game written next year -- is still covered.
     Anything can opt in by carrying data-gate="account" or data-gate="sapien".

     This is presentation, not security. The API refuses the underlying calls
     to anyone without a session regardless of what the page shows; this only
     makes sure the page never offers a door that will not open. */
  /* ---------- the daily-game row ------------------------------------------
     Both games open on a row of day buttons that scrolls sideways: TODAY
     first, then one button per earlier day, numbered by its day of the month
     ("18", "09"). Earlier days are Sapien's, so each carries data-gate and
     the guard below answers anyone else before the game ever sees the tap.
     A game passes plain facts about each day; the markup lives here so the
     two games cannot drift apart. A past game counts for the player's own
     record only -- not that day's ranking and not the streak. */
  var PAST_DAYS = 30;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /* days: [{key:'2026-10-18', today:bool, done:bool, sub:'Play'}], newest first.
     A key is read as a calendar date; no clock is involved. */
  function dayButtons(days) {
    return days.map(function (d) {
      var p = String(d.key).split('-'), mo = MONTHS[(+p[1] || 1) - 1], dd = p[2] || '';
      var long = (+dd) + ' ' + mo + ' ' + p[0];
      var sub = d.sub != null ? d.sub : (d.done ? '\u2713 ' + mo : mo);
      var aria = (d.today ? 'Today, ' : '') + long + (d.done ? ', played' : '');
      return '<button type="button" class="btn dayb' + (d.today ? '' : ' alt ghost') +
        (d.done ? ' done' : '') + '" data-day="' + escapeAttr(d.key) + '"' +
        (d.today ? '' : ' data-gate="sapien" data-gate-label="past daily games"') +
        ' aria-label="' + escapeAttr(aria) + '">' +
        '<span class="dayn">' + (d.today ? 'TODAY' : escapeAttr(dd)) + '</span>' +
        (sub ? '<small>' + escapeAttr(sub) + '</small>' : '') + '</button>';
    }).join('');
  }

  /* A mouse wheel only scrolls up and down, and the row only scrolls across,
     so over the row the wheel is turned sideways. A trackpad's own sideways
     swipe (deltaX) is left alone. Wired once per row element. */
  function wireDayRow(el) {
    if (!el || el.__wired) return;
    el.__wired = true;
    el.addEventListener('wheel', function (e) {
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });
  }

  var GATE_LABEL = { statsBtn: 'Analytics', friendsBtn: 'Friends', friendsGamesBtn: 'Friends’ games' };

  function needFor(t) {
    var g = t.getAttribute('data-gate');
    if (g) return g;
    if (t.id === 'addBtn') return isShell() ? 'account' : 'sapien';   // in a game, Add = make a puzzle
    return 'account';
  }
  function labelFor(t) {
    /* A control can name itself for the gate's message, which beats guessing
       from its text -- "starting a challenge" reads better in that sentence
       than "New 1v1 challenge" would, and a button carrying a badge has the
       badge's number in its textContent. */
    var explicit = t.getAttribute('data-gate-label');
    if (explicit) return explicit;
    if (t.getAttribute('data-go') === 'friends') return 'Friends’ games';
    if (t.id === 'addBtn') return isShell() ? 'Suggest a game' : 'making puzzles';
    return GATE_LABEL[t.id] || (t.textContent || '').replace(/^\s*Play\s+/i, '').trim();
  }
  function allowed(need, u) {
    if (!u) return false;
    return need === 'sapien' ? planOf(u) === 'sapien' : true;
  }
  function deny(need, t) {
    if (!ME.user) {
      var m = document.getElementById('gateMsg');
      if (m) {
        /* A Sapien control cannot promise "it is free": signing up is, the
           thing behind the button is not. */
        m.innerHTML = need === 'sapien'
          ? 'Sign up or sign in to use <b>' + escapeAttr(labelFor(t)) + '</b>. ' +
            'Signing up is free, and Sapien can be added after.'
          : 'Sign up or sign in to use <b>' + escapeAttr(labelFor(t)) + '</b>. ' +
            'It is free, and it keeps your streak when you change device.';
      }
      gateReset();
      UI.open('gateSheet');
    } else {
      UI.open('payWall');          // signed in, but this needs Sapien
    }
  }
  function guard(e) {
    var t = e.target && e.target.closest
      ? e.target.closest('#statsBtn, #friendsBtn, #addBtn, [data-gate]') : null;
    if (!t || t.__pass) return;
    var need = needFor(t);
    if (ME.known) {
      if (allowed(need, ME.user)) return;              // through, untouched
      e.preventDefault(); e.stopPropagation();
      deny(need, t);
      return;
    }
    /* Not known yet: hold the tap, decide when the answer lands, then either
       replay it for real or show the gate. */
    e.preventDefault(); e.stopPropagation();
    whenUser().then(function (u) {
      if (allowed(need, u)) { t.__pass = true; try { t.click(); } finally { t.__pass = false; } }
      else deny(need, t);
    });
  }

  /* ---------------------------------------------------- gate: sign in ----
     The card signs in on its own with three plain requests, so it works inside
     a game that has never heard of the SDK. On success the page reloads: every
     surface already knows how to draw itself for a signed-in player on load,
     and a reload is the one way to be sure all of it agrees. */
  /* Two copies of the same card: the gate (ids gt*) and the Profile card's
     signed-out half (ids pfs*). One function wires either, by prefix. */
  function siNote(px, msg, bad) {
    var n = document.getElementById(px + 'Note');
    if (!n) return;
    n.hidden = !msg; n.textContent = msg || '';
    n.classList.toggle('bad', !!bad);
  }
  function signinReset(px) {
    var ef = document.getElementById(px + 'EmailForm'), cf = document.getElementById(px + 'CodeForm');
    if (ef) ef.hidden = false;
    if (cf) cf.hidden = true;
    siNote(px, '', false);
  }
  function gtNote(msg, bad) { siNote('gt', msg, bad); }
  function gateReset() { signinReset('gt'); }
  function deviceId() {
    try { return localStorage.getItem('ps:device') || ''; } catch (e) { return ''; }
  }
  function api(method, path, body) {
    var h = { Accept: 'application/json' };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    var dev = deviceId(); if (dev) h['X-PS-Device'] = dev;
    return fetch('/api' + path, {
      method: method, credentials: 'include', headers: h,
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        return { ok: r.ok && !(j && j.ok === false), data: j && j.data, status: r.status,
                 error: (j && j.error) || null };
      });
    }).catch(function () { return { ok: false, data: null, status: 0 }; });
  }
  function wireSignin(px) {
    var ef = document.getElementById(px + 'EmailForm');
    if (!ef || ef.__wired) return;
    ef.__wired = true;
    var cf = document.getElementById(px + 'CodeForm');
    var addr = '';
    var note = function (m, b) { siNote(px, m, b); };

    ef.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = (document.getElementById(px + 'Email').value || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { note('That does not look like an email address.', true); return; }
      addr = v;
      note('Sending…', false);
      api('POST', '/auth/email/start', { email: v }).then(function (r) {
        if (!r.ok) { note(r.status === 429 ? 'Too many tries. Wait a minute and try again.' : 'That did not send. Try again.', true); return; }
        note('', false);
        document.getElementById(px + 'Addr').textContent = v;
        ef.hidden = true; cf.hidden = false;
        var c = document.getElementById(px + 'Code'); if (c) { c.value = ''; c.focus(); }
      });
    });

    cf.addEventListener('submit', function (e) {
      e.preventDefault();
      var code = (document.getElementById(px + 'Code').value || '').replace(/\D/g, '');
      if (code.length !== 6) { note('The code is six digits.', true); return; }
      note('Checking…', false);
      api('POST', '/auth/email/verify', { email: addr, code: code }).then(function (r) {
        if (!r.ok) { note('That code did not work. Check it, or ask for a new one.', true); return; }
        /* Carry this browser's history into the account before reloading --
           what the SDK does after its own sign-in. Best effort: a failure here
           loses nothing, it is simply retried the next time the SDK runs.
           Then reload: every surface already knows how to draw itself for a
           signed-in player on load, and a reload is the one way to be sure all
           of it agrees. */
        var dev = deviceId();
        var after = dev ? api('POST', '/player/claim', { device_ids: [dev] }) : Promise.resolve();
        after.then(function () { location.reload(); });
      });
    });

    var back = document.getElementById(px + 'Back');
    if (back) back.addEventListener('click', function () { signinReset(px); });

    var g = document.getElementById(px + 'Google');
    if (g) g.addEventListener('click', function () {
      location.href = '/api/auth/google/start?next=' + encodeURIComponent(location.pathname);
    });
  }
  function wireGate() { wireSignin('gt'); wireSignin('pfs'); }

  /* --------------------------------------------------------- who is here ----
     The strip at the top-left of Analytics, Friends, Settings and Profile, on
     every surface: the player's face, their name over their email, a hairline,
     then the card's own title. Any element marked data-ps-who is filled from
     here, so a card opts in with one empty div and never has to repaint it --
     a name change or a new avatar reaches every card at once.

     Before the session answers it stays blank rather than guessing "Guest":
     a signed-in player should not see themselves signed out for a moment. */
  var PERSON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/>' +
                   '<path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/></svg>';
  function paintWho() {
    var els = document.querySelectorAll('[data-ps-who]');
    if (!els.length) return;
    var u = ME.user, known = ME.known, html;
    if (!known) {
      html = '<span class="psav ps-who-av"></span>' +
             '<span class="ps-who-tx"><b>&nbsp;</b><span>&nbsp;</span></span>';
    } else {
      html = '<span class="psav ps-who-av' + (u ? '' : ' anon') + '">' +
               (u ? avatar(u) : PERSON_SVG) + '</span>' +
             '<span class="ps-who-tx"><b>' +
               escapeAttr(u ? (u.display_name || u.handle || 'Player') : 'Guest') +
             '</b><span>' + escapeAttr(u ? (u.email || '') : 'Not signed in') + '</span></span>';
    }
    html += '<span class="ps-who-rule" aria-hidden="true"></span>';
    for (var i = 0; i < els.length; i++) els[i].innerHTML = html;
  }

  /* ------------------------------------------------------------ profile ----
     One Profile card for every surface, in packages/ui/bar.html, painted from
     here. The front door used to own it and each game showed "Nothing here
     yet"; now a player sees the same card, in the colours of wherever they
     are, with the same sign-in, the same account type, the same avatar and
     the same list of devices.

     The avatar and name section is a DRAFT until Save. Picking a face,
     uploading a picture, deleting it -- none of it is sent until Save, and
     Cancel puts back what was last saved. That is what makes it safe to look
     around: nothing changes for friends until the player says so. */
  var PLAN_TEXT = {
    free: 'Free keeps everything you play; daily results count in Analytics and are ' +
          'ranked against others; but no puzzles of your own or history.',
    sapien: '$2/mo billed annually allowing friends, building and sharing puzzles, ' +
            'tracking all your results, comparing against just friends, and more.'
  };
  var CATS = [
    { k: 'icons',    name: 'Icons' },
    { k: 'monsters', name: 'Monsters' },
    { k: 'robots',   name: 'Robots' },
    { k: 'animals',  name: 'Animals' },
    { k: 'custom',   name: 'Your Image' }
  ];
  var CAT_KIND = { monsters: 'monster', robots: 'robot', animals: 'animal' };
  var PF = { uid: null, draft: null, rand: {} };

  function catOf(token) {
    token = String(token || '');
    if (/^ps-\d{2}$/.test(token)) return 'icons';
    if (/^monster-\d{2}$/.test(token)) return 'monsters';
    if (/^robot-\d{2}b?$/.test(token)) return 'robots';
    if (/^animal-\d{2}[a-f]$/.test(token)) return 'animals';
    if (token === 'custom') return 'custom';
    return '';
  }
  function setOf(k) {
    var kind = CAT_KIND[k];
    if (kind) return dealFor(ME.user, kind);         // this player's selection
    var icons = avatarTokens(), worn = ME.user && ME.user.avatar;
    if (worn && /^ps-\d{2}$/.test(worn) && icons.indexOf(worn) < 0) icons.push(worn);
    return icons;
  }
  function pfSaved() {
    var u = ME.user || {};
    return { avatar: u.avatar || '', img: u.avatar_img || '', name: u.display_name || '' };
  }
  function pfDirty() {
    if (!PF.draft) return false;
    var s = pfSaved(), d = PF.draft;
    return s.avatar !== d.avatar || s.img !== d.img || s.name !== d.name.trim();
  }
  function pfReset() {
    PF.draft = pfSaved();
    var n = $('nameIn'); if (n) n.value = PF.draft.name;
    nameNote('');
    pfNote('', false);
  }
  function nameNote(msg) {
    var n = $('nameNote'); if (!n) return;
    n.hidden = !msg; n.textContent = msg || '';
  }
  function pfNote(msg, bad) {
    var n = $('avNote'); if (!n) return;
    n.hidden = !msg; n.textContent = msg || ''; n.classList.toggle('bad', !!bad);
  }
  function pfButtons() {
    var dirty = pfDirty();
    var s = $('pfSave'), c = $('pfCancel');
    if (s) s.disabled = !dirty;
    if (c) c.disabled = !dirty;
  }

  function paintProfile() {
    var out = $('pfOut'), inn = $('pfIn');
    if (!out || !inn) return;
    var u = ME.user;
    out.hidden = !ME.known ? true : !!u;
    inn.hidden = !u;
    if (!u) { PF.uid = null; PF.draft = null; return; }
    /* A new player, or nothing being edited: follow the account. An edit in
       progress survives a repaint (a session refresh landing mid-edit must
       not throw away what the player was doing). */
    if (PF.uid !== u.id || !pfDirty()) { PF.uid = u.id; pfReset(); }
    paintPlan();
    paintCats();
    pfButtons();
  }

  /* Signed In > FREE, the one button that changes it, and what the plan is.
     The button's hover shows the OTHER plan's words in the same place, so
     the question "what would I get?" is answered where it is asked. */
  function planWhy(which) {
    var u = ME.user, plan = planOf(u), el = $('planWhy');
    if (!el) return;
    var txt = escapeAttr(PLAN_TEXT[which]);
    if (which === 'sapien' && plan === 'sapien' && u && u.plan_until) {
      txt += '<br><b>Your Sapien access runs through ' + escapeAttr(untilText(u.plan_until)) + '.</b>';
    }
    el.innerHTML = txt;
    el.classList.toggle('peek', which !== plan);
  }
  /* Whole calendar months from `sec` to now. */
  function monthsSince(sec) {
    var a = new Date(sec * 1000), b = new Date();
    var m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    if (b.getDate() < a.getDate()) m--;
    return Math.max(0, m);
  }
  function sinceText(u) {
    var plan = planOf(u);
    var sec = u.plan_started || (plan === 'sapien' ? u.plan_since : u.plan_since) || u.created_at;
    var date = '';
    try {
      date = sec ? new Date(sec * 1000).toLocaleDateString(undefined,
        { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    } catch (e) { date = ''; }
    if (plan !== 'sapien') return 'Free since: ' + (date || '\u2014');
    var m = sec ? monthsSince(sec) : 0;
    return 'Sapien since: ' + (date || '\u2014') +
      ' (' + (m === 0 ? 'less than a month' : m === 1 ? '1 month' : m + ' months') + ')';
  }
  function paintPlan() {
    var plan = planOf(ME.user);
    var since = $('pfSince'); if (since && ME.user) since.textContent = sinceText(ME.user);
    var w = $('pfPlanBtn');
    if (w) {
      w.innerHTML = plan === 'sapien'
        ? '<button class="btn ghost" type="button" id="pfDown">Downgrade to Free</button>'
        : '<button class="btn" type="button" id="pfUp">UPGRADE TO SAPIEN</button>';
    }
    planWhy(plan);
  }

  /* The three category tiles. Each shows the face the player has chosen from
     it, or else one picked at random once per visit (not on every repaint --
     a tile that changed face each time it was looked at would read as a bug). */
  function repFor(k) {
    var d = PF.draft;
    if (d && catOf(d.avatar) === k) return d.avatar;
    if (d && catOf(ME.user && ME.user.avatar) === k) return ME.user.avatar;
    if (!PF.rand[k]) {
      var s = setOf(k);
      PF.rand[k] = s[Math.floor(Math.random() * s.length)];
    }
    return PF.rand[k];
  }
  var PLUS_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  function paintCats() {
    var box = $('avCats'), d = PF.draft;
    if (!box || !d) return;
    var cur = catOf(d.avatar);
    box.innerHTML = CATS.map(function (c) {
      var on = cur === c.k ? ' on' : '';
      if (c.k !== 'custom') {
        return '<div class="avcat' + on + '" data-cat="' + c.k + '">' +
          '<button type="button" class="avcat-pic" data-pick="' + c.k + '" aria-label="' +
            c.name + ': choose an avatar' + (on ? ' (in use)' : '') + '">' +
            '<span class="psav">' + avatar({ avatar: repFor(c.k) }) + '</span></button>' +
          '<span class="avcat-name">' + c.name + '</span></div>';
      }
      if (!d.img) {
        return '<div class="avcat" data-cat="custom">' +
          '<button type="button" class="avcat-pic add" data-op="add" aria-label="Upload your own picture">' +
            '<span class="psav">' + PLUS_SVG + '</span></button>' +
          '<span class="avcat-name">' + c.name + '</span></div>';
      }
      return '<div class="avcat avcat-img' + on + '" data-cat="custom">' +
        '<div class="avcat-pic" tabindex="0" role="group" aria-label="Your image' + (on ? ' (in use)' : '') + '">' +
          '<span class="psav">' + avatar({ avatar: 'custom', avatar_img: d.img }) + '</span>' +
          '<span class="avcat-ops">' +
            '<button type="button" data-op="replace">REPLACE</button>' +
            '<button type="button" data-op="use">USE</button>' +
            '<button type="button" data-op="delete">DELETE</button>' +
          '</span></div>' +
        '<span class="avcat-name">' + c.name + '</span></div>';
    }).join('');
  }

  function openPicker(k) {
    var grid = $('avPickGrid'), t = $('avPickTitle');
    if (!grid) return;
    var c = CATS.filter(function (x) { return x.k === k; })[0];
    if (t) t.textContent = c ? c.name : 'Choose';
    var cur = PF.draft ? PF.draft.avatar : '';
    grid.className = 'avgrid' + (CAT_KIND[k] ? ' big' : '');
    grid.innerHTML = setOf(k).map(function (tok, i) {
      return '<button type="button" data-av="' + tok + '" aria-pressed="' + (tok === cur) + '" ' +
        'aria-label="' + c.name + ' ' + (i + 1) + '"><span class="psav">' +
        avatar({ avatar: tok }) + '</span></button>';
    }).join('');
    UI.open('avPickSheet', { stack: true });
  }

  /* The upload never leaves the browser at full size: centre-cropped to a
     square, drawn at 128px, JPEG, stepped down in quality until it fits the
     API's 24 KB cap. */
  var AV_PX = 128, AV_MAX = 24000;
  function squareDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), im = new Image();
      im.onload = function () {
        try {
          var side = Math.min(im.width, im.height);
          var c = document.createElement('canvas');
          c.width = c.height = AV_PX;
          var g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, AV_PX, AV_PX);
          g.drawImage(im, (im.width - side) / 2, (im.height - side) / 2, side, side, 0, 0, AV_PX, AV_PX);
          var q = 0.82, out = c.toDataURL('image/jpeg', q);
          while (out.length > AV_MAX && q > 0.3) { q -= 0.12; out = c.toDataURL('image/jpeg', q); }
          resolve(out.length > AV_MAX ? null : out);
        } catch (err) { reject(err); }
        finally { URL.revokeObjectURL(url); }
      };
      im.onerror = function () { URL.revokeObjectURL(url); reject(new Error('not an image')); };
      im.src = url;
    });
  }

  /* ---- signed-in devices: every browser signed in to this account ---- */
  var DEVICES = [];
  function describeUA(ua) {
    ua = ua || '';
    var browser = '';
    if (/Edg(e|A|iOS)?\//.test(ua)) browser = 'Edge';
    else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
    else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
    else if (/Firefox\/|FxiOS/.test(ua)) browser = 'Firefox';
    else if (/Chrome\/|CriOS/.test(ua)) browser = 'Chrome';
    else if (/Safari\//.test(ua)) browser = 'Safari';
    var os = '', kind = 'computer';
    if (/iPhone|iPod/.test(ua)) { os = 'iPhone'; kind = 'phone'; }
    else if (/iPad/.test(ua)) { os = 'iPad'; kind = 'tablet'; }
    else if (/Android/.test(ua)) { os = 'Android'; kind = /Mobile/.test(ua) ? 'phone' : 'tablet'; }
    else if (/CrOS/.test(ua)) os = 'Chromebook';
    else if (/Windows/.test(ua)) os = 'Windows';
    else if (/Macintosh|Mac OS X/.test(ua)) os = 'Mac';
    else if (/Linux/.test(ua)) os = 'Linux';
    return { name: browser && os ? browser + ' on ' + os : (browser || os || 'Unknown device'), kind: kind };
  }
  function countryName(cc) {
    if (!cc || !/^[A-Z]{2}$/.test(cc) || cc === 'XX' || cc === 'T1') return '';
    try { return new Intl.DisplayNames(undefined, { type: 'region' }).of(cc) || cc; }
    catch (e) { return cc; }
  }
  function whenUsed(sec) {
    if (!sec) return '';
    var d = Math.max(0, Date.now() / 1000 - sec);
    if (d < 600) return 'Active now';
    if (d < 3600) return 'Used ' + Math.round(d / 60) + ' minutes ago';
    if (d < 86400) { var h = Math.round(d / 3600); return 'Used ' + h + ' hour' + (h > 1 ? 's' : '') + ' ago'; }
    var days = Math.floor(d / 86400);
    if (days === 1) return 'Used yesterday';
    if (days < 30) return 'Used ' + days + ' days ago';
    return 'Last used ' + new Date(sec * 1000).toLocaleDateString(undefined,
      { day: 'numeric', month: 'short', year: 'numeric' });
  }
  var DEV_ICON = {
    phone:    '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>',
    tablet:   '<svg viewBox="0 0 24 24"><rect x="4.5" y="2.5" width="15" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>',
    computer: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16v4"/></svg>'
  };
  function devNote(msg, bad) {
    var n = $('devNote'); if (!n) return;
    n.hidden = !msg; n.textContent = msg || ''; n.classList.toggle('bad', !!bad);
  }
  function loadDevices() {
    if (!ME.user || !$('devList')) return;
    api('GET', '/auth/devices').then(function (r) {
      if (!ME.user) return;
      if (!r.ok) {
        $('devList').innerHTML = '<p class="sethint">' + (r.status === 0
          ? 'Your devices will show here when you’re back online.'
          : 'Your devices could not be loaded just now.') + '</p>';
        $('devAllRow').hidden = true;
        return;
      }
      DEVICES = ((r.data && r.data.devices) || []).slice().sort(function (a, b) {
        return (b.current - a.current) || (b.last_used_at - a.last_used_at);
      });
      paintDevices();
    });
  }
  function paintDevices() {
    var list = $('devList');
    if (!list) return;
    list.textContent = '';
    DEVICES.forEach(function (d) {
      var who = describeUA(d.ua);
      var row = document.createElement('div'); row.className = 'devrow';
      var ic = document.createElement('div'); ic.className = 'ic'; ic.innerHTML = DEV_ICON[who.kind];
      var dn = document.createElement('div'); dn.className = 'dn';
      dn.appendChild(document.createTextNode(who.name));
      if (d.current) {
        var here = document.createElement('span'); here.className = 'here'; here.textContent = 'This device';
        dn.appendChild(here);
      }
      var em = document.createElement('em');
      em.textContent = [d.current ? 'Active now' : whenUsed(d.last_used_at), countryName(d.country)]
        .filter(Boolean).join(' · ');
      dn.appendChild(em);
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn ghost'; btn.textContent = 'Sign out';
      btn.setAttribute('aria-label', 'Sign out ' + who.name + (d.current ? ' (this device)' : ''));
      btn.addEventListener('click', function () { signOutDevice(d, btn); });
      row.appendChild(ic); row.appendChild(dn); row.appendChild(btn);
      list.appendChild(row);
    });
    $('devAllRow').hidden = DEVICES.filter(function (d) { return !d.current; }).length < 2;
  }
  function signOutDevice(d, btn) {
    if (d.current) { signOut(); return; }
    if (btn) btn.disabled = true;
    api('DELETE', '/auth/devices/' + encodeURIComponent(d.id)).then(function (r) {
      if (!r.ok && r.status !== 404) {
        if (btn) btn.disabled = false;
        devNote(r.status === 0 ? 'You’re offline. Try again when you’re connected.'
                               : 'That did not go through. Try again.', true);
        return;
      }
      DEVICES = DEVICES.filter(function (x) { return x.id !== d.id; });
      paintDevices();
      devNote('Signed out. That device will need to sign in again.', false);
    });
  }

  /* The platform SDK (front door only) keeps copies of the account in
     storage; after a sign-out or a deletion they would put the old account
     back on screen at the next load if they were left behind. */
  function dropCachedAccount() {
    try {
      ['ps:cache:session', 'ps:cache:me', 'ps:cache:friends', 'ps:cache:notices'].forEach(function (k) {
        localStorage.removeItem(k);
      });
    } catch (e) { /* storage blocked: nothing was cached either */ }
  }
  function signOut() {
    api('POST', '/auth/logout').then(function () {
      dropCachedAccount();
      DEVICES = [];
      setUser(null);
      toast('Signed out');
    });
  }

  function wireProfile() {
    var sheet = $('profileSheet');
    if (!sheet || sheet.__wired) return;
    sheet.__wired = true;

    /* account type */
    var pw = $('pfPlanBtn');
    pw.addEventListener('click', function (e) {
      if (e.target.closest('#pfUp')) UI.open('payWall', { stack: true });
      else if (e.target.closest('#pfDown')) UI.open('downSheet', { stack: true });
    });
    var other = function () { return planOf(ME.user) === 'sapien' ? 'free' : 'sapien'; };
    pw.addEventListener('mouseover', function (e) { if (e.target.closest('.btn')) planWhy(other()); });
    pw.addEventListener('mouseout', function (e) { if (e.target.closest('.btn')) planWhy(planOf(ME.user)); });
    pw.addEventListener('focusin', function () { planWhy(other()); });
    pw.addEventListener('focusout', function () { planWhy(planOf(ME.user)); });

    var dy = $('downYes');
    if (dy) dy.addEventListener('click', function () {
      dy.disabled = true;
      api('PATCH', '/player/me', { plan: 'free' }).then(function (r) {
        dy.disabled = false;
        close();                                   // back to the Profile card
        if (!r.ok || !(r.data && r.data.user)) { toast('That did not save.'); return; }
        setUser(r.data.user);
        toast('You are on the Free plan.');
      });
    });

    /* the avatar categories */
    var cats = $('avCats'), file = $('avFile');
    cats.addEventListener('click', function (e) {
      var pick = e.target.closest('[data-pick]');
      if (pick) { openPicker(pick.getAttribute('data-pick')); return; }
      var op = e.target.closest('[data-op]');
      var tile = e.target.closest('.avcat-img');
      if (!op) {
        /* A touch screen has no hover: the first tap on the picture shows the
           three choices, a tap elsewhere on it hides them again. */
        if (tile) tile.classList.toggle('open');
        return;
      }
      var what = op.getAttribute('data-op');
      if (what === 'add' || what === 'replace') { file.click(); return; }
      if (what === 'use') { PF.draft.avatar = 'custom'; }
      if (what === 'delete') {
        PF.draft.img = '';
        if (PF.draft.avatar === 'custom') PF.draft.avatar = '';
      }
      paintCats(); pfButtons();
    });
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      file.value = '';                             // the same file can be picked again
      if (!f) return;
      if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { pfNote('PNG, JPEG or WebP, please.', true); return; }
      pfNote('Resizing…', false);
      squareDataUrl(f).then(function (data) {
        if (!data) { pfNote('That picture will not compress small enough. Try another.', true); return; }
        PF.draft.img = data;
        PF.draft.avatar = 'custom';                // an upload becomes the avatar
        pfNote('', false);
        paintCats(); pfButtons();
      }, function () { pfNote('That file could not be read as a picture.', true); });
    });
    var grid = $('avPickGrid');
    if (grid) grid.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-av]');
      if (!b || !PF.draft) return;
      PF.draft.avatar = b.getAttribute('data-av');
      close();
      paintCats(); pfButtons();
    });

    /* name, save, cancel */
    $('nameIn').addEventListener('input', function (e) {
      nameNote('');
      if (PF.draft) { PF.draft.name = e.target.value; pfButtons(); }
    });
    $('pfCancel').addEventListener('click', function () { pfReset(); paintCats(); pfButtons(); });
    $('pfSave').addEventListener('click', function () {
      var d = PF.draft, s = pfSaved(), btn = $('pfSave');
      if (!d) return;
      var patch = { display_name: d.name.trim(), avatar: d.avatar || null };
      if (d.img !== s.img) patch.avatar_img = d.img || null;
      btn.disabled = true;
      pfNote('Saving…', false);
      api('PATCH', '/player/me', patch).then(function (r) {
        if (r.status === 409) {
          pfNote('', false);
          nameNote('That display name is already taken. Please choose another.');
          $('nameIn').focus();
          pfButtons();
          return;
        }
        if (!r.ok || !(r.data && r.data.user)) {
          pfNote(r.status === 413 ? 'That picture is too big. Try a smaller one.'
               : r.status === 0 ? 'You’re offline. Try again when you’re connected.'
               : 'That did not save. Try again.', true);
          pfButtons();
          return;
        }
        PF.draft = null;                           // the account is the truth again
        setUser(r.data.user);
        pfNote('Saved.', false);
        setTimeout(function () { if ($('avNote').textContent === 'Saved.') pfNote('', false); }, 1800);
      });
    });

    /* devices, sign out, delete */
    $('devAllBtn').addEventListener('click', function () {
      var btn = $('devAllBtn'), others = DEVICES.filter(function (d) { return !d.current; }), failed = 0;
      btn.disabled = true;
      Promise.all(others.map(function (d) {
        return api('DELETE', '/auth/devices/' + encodeURIComponent(d.id)).then(function (r) {
          if (r.ok || r.status === 404) DEVICES = DEVICES.filter(function (x) { return x.id !== d.id; });
          else failed++;
        });
      })).then(function () {
        btn.disabled = false;
        paintDevices();
        devNote(failed ? 'Some devices could not be signed out. Try again.'
                       : 'Every other device is signed out. Only this one is still signed in.', !!failed);
      });
    });
    $('signOutBtn').addEventListener('click', signOut);

    $('delBtn').addEventListener('click', function () {
      $('delIn').value = ''; $('delGo').disabled = true;
      var n = $('delNote'); n.hidden = true; n.textContent = '';
      UI.open('delSheet', { stack: true });
    });
    $('delIn').addEventListener('input', function (e) {
      $('delGo').disabled = e.target.value.trim().toUpperCase() !== 'DELETE';
    });
    $('delGo').addEventListener('click', function () {
      $('delGo').disabled = true;
      api('DELETE', '/player/me').then(function (r) {
        if (!r.ok) {
          var n = $('delNote');
          n.hidden = false; n.classList.add('bad');
          n.textContent = 'That did not go through. Nothing has been deleted — try again.';
          $('delGo').disabled = false;
          return;
        }
        closeAll();
        dropCachedAccount();
        setUser(null);
        toast('Your account has been deleted.');
      });
    });
  }

  /* ------------------------------------------------------------ friends ----
     The Friends card, the same on every surface. The server decides what is
     allowed (routes/friends.js); this shows the lists and sends the taps.
     An invite typed as an email address always reports "Sent." -- the server
     never says whether that address belongs to a player. */
  var FR = { data: null, busy: false, open: {}, adding: null, deleting: null };
  function frNote(msg, bad) {
    var n = $('frNote'); if (!n) return;
    n.hidden = !msg; n.textContent = msg || ''; n.classList.toggle('bad', !!bad);
  }
  function frName(f) { return escapeAttr(f.display_name || f.handle || 'Player'); }
  function frBtn(act, id, label, ghost) {
    return '<button type="button" class="btn' + (ghost ? ' ghost' : '') + '" data-fr="' + act +
      '" data-id="' + escapeAttr(id) + '">' + label + '</button>';
  }
  function frRow(f, note, acts, wide) {
    return '<div class="frrow' + (wide ? ' wide' : '') + '"><span class="psav">' + avatar(f) + '</span>' +
      '<div class="fn">' + frName(f) + (note ? '<em>' + note + '</em>' : '') + '</div>' +
      '<div class="acts">' + acts + '</div></div>';
  }
  function frSection(title, small, body) {
    return '<section class="frsec"><h3 class="pf-sub">' + title +
      (small ? ' <small>' + small + '</small>' : '') + '</h3>' + body + '</section>';
  }
  var TRASH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/>' +
    '<path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/></svg>';
  /* One collapsible list: ALL, each group, Blocked. Which are open is kept in
     FR.open across repaints (ALL starts open, the rest closed). */
  function frList(key, title, count, rows, empty, trash) {
    var open = FR.open[key] != null ? FR.open[key] : key === 'all';
    return '<details class="frlist" data-list="' + escapeAttr(key) + '"' + (open ? ' open' : '') + '>' +
      '<summary><span class="frarrow" aria-hidden="true"></span><span class="frtitle">' + title + '</span>' +
      '<small>' + count + '</small>' +
      (trash ? '<button type="button" class="frtrash" data-grpdel="' + escapeAttr(trash.id) + '" ' +
        'data-name="' + escapeAttr(trash.name) + '" aria-label="Delete the group ' + escapeAttr(trash.name) +
        '" title="Delete this group">' + TRASH + '</button>' : '') +
      '</summary>' + (rows || '<p class="sethint">' + empty + '</p>') + '</details>';
  }
  function paintFriends() {
    var out = $('frOut'), inn = $('frIn'), box = $('frLists'), invBox = $('frInvites'), sentBox = $('frSent');
    if (!out || !inn) return;
    out.hidden = !!ME.user || !ME.known; inn.hidden = !ME.user;
    if (!ME.user || !box) return;
    var d = FR.data;
    if (!d) { box.innerHTML = '<p class="sethint">Loading…</p>'; return; }

    /* Invites waiting for an answer, at the top of the card. */
    var h = '';
    if (d.paused_until) {
      h += '<div class="ui-note bad frpaused">Several of your recent invites were declined, so ' +
        'sending invites is paused until ' + new Date(d.paused_until * 1000).toLocaleDateString(undefined,
        { month: 'long', day: 'numeric' }) + '.</div>';
    }
    var q = d.queue || { used: 0, cap: 30, waiting: 0 };
    var inc = d.incoming || [], later = d.later || [];
    if (inc.length || later.length || q.waiting) {
      var body = inc.map(function (f) {
        return frRow(f, 'Wants to be friends',
          frBtn('accept', f.id, 'Accept') + frBtn('later', f.id, 'Later', true) +
          frBtn('reject', f.id, 'Reject', true) + frBtn('block', f.id, 'Block', true), true);
      }).join('');
      if (q.waiting) {
        body += '<p class="sethint">Your list is full. ' + q.waiting + ' more invite' +
          (q.waiting > 1 ? 's are' : ' is') + ' waiting, and will appear as you make room.</p>';
      }
      if (later.length) {
        body += '<p class="sethint" style="margin-top:12px">Saved for later</p>' + later.map(function (f) {
          return frRow(f, 'Saved for later',
            frBtn('accept', f.id, 'Accept') + frBtn('reject', f.id, 'Reject', true) +
            frBtn('block', f.id, 'Block', true), true);
        }).join('');
      }
      h += '<div class="pfsec">' + frSection('Invites for you', q.used + ' of ' + q.cap, body) + '</div>';
    }
    if (invBox) invBox.innerHTML = h;

    /* Invites this player sent, under the invite box. */
    var sent = d.outgoing || [];
    if (sentBox) {
      sentBox.innerHTML = sent.length ? frList('sent', 'Invites you sent', String(sent.length),
        sent.map(function (f) { return frRow(f, 'Waiting for them', frBtn('cancel', f.id, 'Cancel', true)); }).join(''),
        '') : '';
    }

    /* The lists: ALL, then each group A-Z, then Blocked. */
    var acc = d.accepted || [], byId = {};
    acc.forEach(function (f) { byId[f.id] = f; });
    var groups = (d.groups || []).slice().sort(function (a, b) {
      return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0;
    });
    var L = frList('all', 'All', String(acc.length), acc.map(function (f) {
      var row = frRow(f, '', frBtn('block', f.id, 'Block', true) + frBtn('remove', f.id, 'Remove', true) +
        '<button type="button" class="btn ghost" data-fradd="' + escapeAttr(f.id) + '" data-gate="sapien" ' +
        'data-gate-label="friend groups">Add</button>');
      if (FR.adding === f.id) {
        row += '<form class="fraddgrp" data-for="' + escapeAttr(f.id) + '" autocomplete="off">' +
          '<label class="ui-sr" for="frGrpIn">Name of group</label>' +
          '<input class="fld" id="frGrpIn" list="frGroupNames" maxlength="30" ' +
          'placeholder="Name of (existing or new) group">' +
          '<button class="btn" type="submit">Add</button>' +
          '<button class="btn ghost" type="button" data-fraddcancel>Cancel</button></form>';
      }
      return row;
    }).join(''), 'No friends yet. Invite someone above, or share your code.');
    groups.forEach(function (g) {
      var members = g.members.filter(function (id) { return byId[id]; });
      L += frList('g:' + g.id, escapeAttr(g.name), String(members.length), members.map(function (id) {
        return frRow(byId[id], '', '<button type="button" class="btn ghost" data-grprm="' + escapeAttr(g.id) +
          '" data-id="' + escapeAttr(id) + '" title="Take out of this group (they stay your friend)">Remove</button>');
      }).join(''), 'Nobody in this group yet. Use Add under All.', { id: g.id, name: g.name });
    });
    var bl = d.blocked || [];
    L += frList('blocked', 'Blocked', String(bl.length),
      bl.map(function (f) { return frRow(f, 'Blocked', frBtn('unblock', f.id, 'Unblock', true)); }).join(''),
      'Nobody. A blocked player cannot invite you or see you, and is never told.');
    box.innerHTML = L;

    var dl = $('frGroupNames');
    if (dl) dl.innerHTML = groups.map(function (g) { return '<option value="' + escapeAttr(g.name) + '">'; }).join('');
    var gi = $('frGrpIn');
    if (gi && FR.focusAdd) { FR.focusAdd = false; try { gi.focus(); } catch (e) {} }

    /* Analytics compares against the same groups. */
    GROUPS = groups.map(function (g) { return { id: g.id, name: g.name }; });
    paintGroups();
  }
  function loadFriends() {
    if (!ME.user) { paintFriends(); return; }
    Promise.all([api('GET', '/player/friends/code'), api('GET', '/player/friends')]).then(function (r) {
      var c = $('frCode');
      if (c && r[0].ok && r[0].data && r[0].data.code) c.textContent = r[0].data.code;
      if (r[1].ok) FR.data = r[1].data;
      else if (!FR.data) FR.data = { accepted: [], incoming: [], later: [], outgoing: [], blocked: [], groups: [] };
      paintFriends();
    });
  }
  var FR_ACT = {
    accept:  { m: 'POST',   p: '/accept',  t: 'You are now friends.' },
    later:   { m: 'POST',   p: '/later',   t: 'Saved for later.' },
    reject:  { m: 'POST',   p: '/reject',  t: 'Invite rejected.' },
    block:   { m: 'POST',   p: '/block',   t: 'Blocked. You can undo this under Blocked.' },
    unblock: { m: 'POST',   p: '/unblock', t: 'Unblocked.' },
    remove:  { m: 'DELETE', p: '',         t: 'Removed.' },
    cancel:  { m: 'DELETE', p: '',         t: 'Invite cancelled.' }
  };
  function groupName(id) {
    var g = ((FR.data && FR.data.groups) || []).filter(function (x) { return x.id === id; })[0];
    return g ? g.name : 'the group';
  }
  function wireFriends() {
    var f = $('frAddForm');
    if (!f || f.__wired) return;
    f.__wired = true;
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = ($('frAddIn').value || '').trim();
      if (!v || FR.busy) return;
      var byEmail = v.indexOf('@') >= 0;
      FR.busy = true; $('frAddBtn').disabled = true;
      frNote('Sending…', false);
      (byEmail ? api('POST', '/player/friends/invite', { email: v })
               : api('POST', '/player/friends/add', { code: v.toUpperCase() })).then(function (r) {
        FR.busy = false; $('frAddBtn').disabled = false;
        if (r.ok) {
          $('frAddIn').value = '';
          frNote(byEmail ? 'Sent.' : (r.data && r.data.state === 'accepted' ? 'You are now friends.' : 'Sent.'), false);
          loadFriends();
          return;
        }
        frNote(r.status === 429 ? 'That is the limit for now. Try again later.'
          : r.status === 403 ? 'Several of your recent invites were declined, so sending invites is paused for a few days.'
          : r.status === 0 ? 'You’re offline. Try again when you’re connected.'
          : byEmail ? 'That does not look like an email address you can invite.'
          : r.status === 409 ? 'Already sent, or you are already friends.'
          : 'That invite code did not work.', true);
      });
    });

    /* Share: on a phone this opens the share sheet (Messages, Mail, Copy...);
       where there is none, the link is copied instead. */
    $('frCopy').addEventListener('click', function () {
      var c = ($('frCode').textContent || '').trim();
      if (!/^[A-Z0-9]{8}$/i.test(c)) { toast('Your code has not loaded yet'); return; }
      var link = location.origin + '/?f=' + c;
      var copy = function () {
        try { navigator.clipboard.writeText(link).then(function () { toast('Invite link copied'); },
          function () { toast(link); }); }
        catch (e) { toast(link); }
      };
      if (navigator.share) {
        navigator.share({ title: 'PlaySapien', text: 'Be my friend on PlaySapien. My invite code is ' + c + '.', url: link })
          .catch(function (err) { if (!err || err.name !== 'AbortError') copy(); });
      } else copy();
    });

    var lists = $('frLists'), sentBox = $('frSent');
    /* Remember which lists are open, so a repaint does not snap them shut. */
    function trackToggle(root) {
      root.addEventListener('toggle', function (e) {
        var dt = e.target;
        if (dt && dt.classList && dt.classList.contains('frlist')) FR.open[dt.getAttribute('data-list')] = dt.open;
      }, true);
    }
    trackToggle(lists); if (sentBox) trackToggle(sentBox);

    function onAction(e) {
      /* The trash can sits in a list's summary: delete, do not toggle. */
      var t = e.target.closest('[data-grpdel]');
      if (t) {
        e.preventDefault(); e.stopPropagation();
        FR.deleting = t.getAttribute('data-grpdel');
        $('grpDelName').textContent = '“' + t.getAttribute('data-name') + '”';
        UI.open('grpDelSheet', { stack: true });
        return;
      }
      var add = e.target.closest('[data-fradd]');
      if (add) {
        var who = add.getAttribute('data-fradd');
        FR.adding = FR.adding === who ? null : who; FR.focusAdd = true;
        paintFriends(); return;
      }
      if (e.target.closest('[data-fraddcancel]')) { FR.adding = null; paintFriends(); return; }
      var rm = e.target.closest('[data-grprm]');
      if (rm) {
        rm.disabled = true;
        var gid = rm.getAttribute('data-grprm'), nm = groupName(gid);
        api('DELETE', '/player/groups/' + encodeURIComponent(gid) + '/members/' +
            encodeURIComponent(rm.getAttribute('data-id'))).then(function (r) {
          toast(r.ok ? 'Removed from ' + nm + '.' : 'That did not go through. Try again.');
          loadFriends();
        });
        return;
      }
      var b = e.target.closest('[data-fr]'); if (!b) return;
      var a = FR_ACT[b.getAttribute('data-fr')]; if (!a) return;
      b.disabled = true;
      if (b.getAttribute('data-fr') === 'unblock') FR.open.blocked = true;
      api(a.m, '/player/friends/' + encodeURIComponent(b.getAttribute('data-id')) + a.p,
          a.m === 'POST' ? {} : undefined).then(function (r) {
        toast(r.ok ? a.t : 'That did not go through. Try again.');
        loadFriends();
      });
    }
    lists.addEventListener('click', onAction);
    if (sentBox) sentBox.addEventListener('click', onAction);
    var inv = $('frInvites'); if (inv) inv.addEventListener('click', onAction);

    /* Add to a group: an existing name, or a new one, which makes the group. */
    lists.addEventListener('submit', function (e) {
      var form = e.target.closest('.fraddgrp'); if (!form) return;
      e.preventDefault();
      var name = ($('frGrpIn').value || '').replace(/\s+/g, ' ').replace(/^ | $/g, '');
      if (!name) { toast('Type a group name.'); return; }
      var friendId = form.getAttribute('data-for');
      [].forEach.call(form.querySelectorAll('button'), function (x) { x.disabled = true; });
      api('POST', '/player/groups/add', { name: name, friend_id: friendId }).then(function (r) {
        if (r.ok) {
          FR.adding = null;
          FR.open['g:' + r.data.group.id] = true;
          toast('Added to ' + r.data.group.name + '.');
          loadFriends(); return;
        }
        [].forEach.call(form.querySelectorAll('button'), function (x) { x.disabled = false; });
        if (r.status === 403) { UI.open('payWall', { stack: true }); return; }
        var code = r.error && r.error.code;
        toast(code === 'reserved_name' ? 'That name is already used on this card. Choose another.'
            : code === 'too_many_groups' ? 'You have the most groups allowed. Delete one first.'
            : code === 'group_full' ? 'That group is full.'
            : r.status === 0 ? 'You’re offline. Try again when you’re connected.'
            : 'That did not go through. Try again.');
      });
    });

    $('grpDelYes').addEventListener('click', function () {
      var id = FR.deleting; if (!id) { close(); return; }
      var nm = groupName(id), btn = $('grpDelYes');
      btn.disabled = true;
      api('DELETE', '/player/groups/' + encodeURIComponent(id)).then(function (r) {
        btn.disabled = false; FR.deleting = null; close();
        toast(r.ok ? 'Deleted ' + nm + '.' : 'That did not go through. Try again.');
        loadFriends();
      });
    });
  }

  /* ----------------------------------------------------- promotion code ----
     Sends what was typed; the server decides. On success the page reloads,
     for the same reason the gate does: every surface already knows how to draw
     itself for a Sapien player on load, and a reload is the one way to be sure
     all of it -- the bar, the gate, the Analytics tiers -- agrees at once. */
  function untilText(sec) {
    /* plan_until is the first instant the grant NO LONGER applies, so the last
       day of access is the day before it -- read in UTC, where it was set. */
    try {
      return new Date((sec - 1) * 1000).toLocaleDateString(undefined,
        { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    } catch (e) { return ''; }
  }
  /* The free trial on the upgrade card: offered only to a signed-in Free
     player whose email address has never had one (the server decides; this
     only reflects what /auth/session said). */
  function paintPayWall() {
    var box = $('trialBox'), u = ME.user;
    if (!box) return;
    box.hidden = !(u && planOf(u) !== 'sapien' && u.trial_available);
    var n = $('trialNote'); if (n) { n.hidden = true; n.textContent = ''; }
  }
  function wireTrial() {
    var b = $('trialBtn');
    if (!b || b.__wired) return;
    b.__wired = true;
    b.addEventListener('click', function () {
      b.disabled = true;
      api('POST', '/player/trial').then(function (r) {
        b.disabled = false;
        if (r.ok && r.data && r.data.user) {
          close();                                 // back to wherever the upgrade was opened from
          setUser(r.data.user);
          toast('Sapien is yours for two days. Enjoy!');
          return;
        }
        var n = $('trialNote');
        n.hidden = false; n.classList.add('bad');
        n.textContent = r.status === 409 ? 'The free trial has already been used for this email address.'
                      : r.status === 0 ? 'You\u2019re offline. Try again when you\u2019re connected.'
                      : 'That did not work. Try again.';
        if (r.status === 409 && ME.user) { ME.user.trial_available = false; }
      });
    });
  }

  /* ------------------------------------------------------------ name ----
     A new player is asked once to choose a display name. The server has
     already put a proposal on the account (the start of their email plus a
     tag, "kai 39K", or the name Google gave) and says name_needed until they
     save one. "Not now" is fine: they are asked again on a later visit, at
     most once per visit, and the proposal stands in the meantime. */
  var NAMEASK = { asked: false };
  function askName() {
    var u = ME.user;
    if (!u || !u.name_needed || NAMEASK.asked || !$('nameSheet')) return;
    try { if (sessionStorage.getItem('ps:nameAsked') === u.id) return; } catch (e) {}
    NAMEASK.asked = true;
    try { sessionStorage.setItem('ps:nameAsked', u.id); } catch (e) {}
    var show = function (name) {
      $('nameAskIn').value = name || '';
      nameAskNote('');
      UI.open('nameSheet', { stack: true });
    };
    /* A proposal is always on the account by the time /auth/session answers;
       a sign-in response for an older account may not carry one yet. */
    if (u.display_name) { setTimeout(function () { show(u.display_name); }, 350); return; }
    api('GET', '/auth/session').then(function (r) {
      var v = r.ok && r.data && r.data.user;
      if (v && v.name_needed) show(v.display_name);
    });
  }
  function nameAskNote(msg) {
    var n = $('nameAskNote');
    if (n) { n.hidden = !msg; n.textContent = msg || ''; }
  }
  function wireNameAsk() {
    var f = $('nameAskForm');
    if (!f || f.__wired) return;
    f.__wired = true;
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = ($('nameAskIn').value || '').replace(/\s+/g, ' ').replace(/^ | $/g, '');
      if (!name) { nameAskNote('Please enter a name.'); return; }
      var b = $('nameAskSave'); b.disabled = true;
      api('PATCH', '/player/me', { display_name: name }).then(function (r) {
        b.disabled = false;
        if (r.ok && r.data && r.data.user) {
          close();
          setUser(r.data.user);
          toast('Saved. Welcome, ' + r.data.user.display_name + '!');
          return;
        }
        nameAskNote(r.status === 409 ? 'That display name is already taken. Please choose another.'
                  : r.status === 0 ? 'You\u2019re offline. Try again when you\u2019re connected.'
                  : 'That did not work. Try again.');
      });
    });
  }

  /* Friend challenges are not built yet (no server side), so starting one
     says so rather than doing nothing. The gate still runs first: a Free
     player is shown Sapien, a Sapien player is told it is on its way. */
  function wireChallenges() {
    ['timedNew', 'duelNew'].forEach(function (id) {
      var b = $(id);
      if (!b || b.__wired) return;
      b.__wired = true;
      b.addEventListener('click', function () {
        toast('Friend challenges are coming soon. We\u2019ll let you know when they\u2019re ready.', 4000);
      });
    });
  }

  function wirePromo() {
    var f = document.getElementById('promoForm');
    if (!f || f.__wired) return;
    f.__wired = true;
    var note = function (msg, bad) {
      var n = document.getElementById('promoNote');
      n.hidden = !msg; n.textContent = msg || ''; n.classList.toggle('bad', !!bad);
    };
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var code = (document.getElementById('promoIn').value || '').trim();
      if (!code) return;
      var btn = document.getElementById('promoBtn');
      btn.disabled = true;
      note('Checking\u2026', false);
      api('POST', '/player/redeem', { code: code }).then(function (r) {
        btn.disabled = false;
        if (r.ok) {
          var until = r.data && r.data.granted_until;
          note(until ? 'Done \u2014 you are Sapien through ' + untilText(until) + '.'
                     : 'Done \u2014 you are Sapien.', false);
          setTimeout(function () { location.reload(); }, 1400);
          return;
        }
        note(r.status === 401 ? 'Sign in first, then enter the code.'
           : r.status === 409 ? 'You have already used this code.'
           : r.status === 429 ? 'Too many tries. Wait a while and try again.'
           : 'That code is not valid.', true);
      });
    });
  }

  /* ------------------------------------------------------- analytics ---- */
  var GROUPS = [];                         // filled by setFriendGroups() once groups exist
  function paintAnalytics() {
    var u = ME.user, sapien = planOf(u) === 'sapien';
    var what = document.getElementById('anWhat');
    if (what) {
      what.textContent = isShell()
        ? 'Intellisense score · every game'
        : (document.title || 'This game').split(/[·|—-]/)[0].trim() + ' · this game';
    }
    /* Free: Daily only. The other two horizons stay visible as headings, so a
       free player can see what exists, with one upgrade note under both. */
    ['dozen', 'lifetime'].forEach(function (k) {
      var b = document.querySelector('#statsSheet .an-block[data-tier="' + k + '"]');
      if (b) b.classList.toggle('locked', !sapien);
    });
    var lock = document.getElementById('anLock');
    if (lock) lock.hidden = sapien;
    paintGroups();
    AN.data = null; AN.failed = false;
    paintAnalyticsBody();
    /* The groups are only fetched when the Friends card opens, so ask for them
       here too -- a player can open Analytics first. */
    if (!ME.user) return;
    api('GET', '/player/groups').then(function (r) {
      if (r.ok && r.data && Array.isArray(r.data.groups)) {
        GROUPS = r.data.groups.map(function (g) { return { id: g.id, name: g.name }; });
        paintGroups();
      }
      loadAnalytics();
    });
  }
  function paintGroups() {
    var sel = document.getElementById('anGroup'), none = document.getElementById('anNoGroups');
    if (!sel || !none) return;
    if (!GROUPS.length) { AN.group = ''; sel.hidden = true; none.hidden = false; return; }
    sel.innerHTML = GROUPS.map(function (g) {
      return '<option value="' + escapeAttr(g.id) + '">' + escapeAttr(g.name) + '</option>';
    }).join('');
    /* Keep the group that was picked; fall back to the first if it is gone. */
    var keep = GROUPS.some(function (g) { return g.id === AN.group; });
    AN.group = keep ? AN.group : GROUPS[0].id;
    sel.value = AN.group;
    sel.hidden = false; none.hidden = true;
  }

  /* The numbers. One request answers every comparison -- all players, all
     friends and the picked group -- so switching between All and Friend groups
     repaints without asking again; only picking a different group does. The
     server decides what this player may see (routes/analytics.js). */
  var AN = { scope: 'all', group: '', data: null, failed: false, seq: 0 };
  /* A game's card reports that game; the front door's card reports them all. */
  function anGame() {
    var m = !isShell() && /^\/(sojourner|wordchain)(\/|$)/.exec(location.pathname);
    return m ? m[1] : 'all';
  }
  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function anNum(you) {
    return you.max === 100 ? (Math.round(you.value * 10) / 10) + '%'
      : Math.round(you.value) + ' / ' + you.max;
  }
  function anCmp(label, c) {
    if (!c) return '';
    var t = c.of < 2 ? 'Only you so far'
      : c.of < 20 ? ordinal(c.rank) + ' of ' + c.of
      : 'Ahead of ' + c.beat + '%';
    return '<div class="an-cmp"><span>' + label + '</span><b>' + t + '</b></div>';
  }
  function anBody(h, kind) {
    if (AN.failed) return '<p class="an-empty">Could not load your numbers. Close this and try again.</p>';
    if (!h) return '<p class="an-empty">Loading…</p>';
    if (!h.you) {
      return '<p class="an-empty">' + (kind === 'daily'
        ? 'Play today’s puzzle to see your score here.'
        : 'Shown once you have played ' + h.needed + ' games (' + h.games + ' so far).') + '</p>';
    }
    var d = AN.data, c = h.compare || {};
    var s = '<div class="an-big">' + anNum(h.you) + '<small>' +
      (kind === 'daily' ? 'today' : kind === 'dozen' ? 'average of your last 12'
        : 'average of all ' + h.games) + '</small></div>';
    if (AN.scope === 'groups') {
      if (d.group && d.group.id === AN.group) s += anCmp(escapeAttr(d.group.name), c.group);
    } else {
      s += anCmp('All players', c.all) + anCmp('All my friends', c.friends);
    }
    if (kind === 'daily') s += '<p class="an-note">Ranks can still change until midnight UTC.</p>';
    return s;
  }
  function paintAnalyticsBody() {
    var d = AN.data;
    [['anDaily', 'daily'], ['anDozen', 'dozen'], ['anLifetime', 'lifetime']].forEach(function (p) {
      var el = document.getElementById(p[0]); if (!el) return;
      var h = d && d[p[1]];
      var locked = !!(h && h.locked);
      el.classList.toggle('filled', !locked && !AN.failed && !!(h && h.you));
      el.innerHTML = locked ? '' : anBody(h, p[1]);
    });
  }
  function loadAnalytics() {
    if (!ME.user) return;
    var mine = ++AN.seq;
    var q = '?game=' + anGame() + (AN.group ? '&group=' + encodeURIComponent(AN.group) : '');
    api('GET', '/player/analytics' + q).then(function (r) {
      if (mine !== AN.seq) return;                          // a newer request is on its way
      if (!r.ok && r.status === 404 && AN.group) {          // the group was deleted meanwhile
        AN.group = ''; paintGroups(); loadAnalytics(); return;
      }
      AN.failed = !r.ok || !r.data;
      AN.data = AN.failed ? null : r.data;
      paintAnalyticsBody();
    });
  }
  function wireAnalytics() {
    var seg = document.getElementById('anScope');
    if (!seg || seg.__wired) return;
    seg.__wired = true;
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-scope]'); if (!b) return;
      [].forEach.call(seg.querySelectorAll('button'), function (x) {
        x.setAttribute('aria-pressed', String(x === b));
      });
      AN.scope = b.getAttribute('data-scope') === 'groups' ? 'groups' : 'all';
      document.getElementById('anGroupWrap').hidden = AN.scope !== 'groups';
      paintGroups();
      paintAnalyticsBody();
    });
    var sel = document.getElementById('anGroup');
    if (sel) {
      sel.addEventListener('change', function () {
        AN.group = sel.value;
        paintAnalyticsBody();                               // stale group's row is hidden until the answer
        loadAnalytics();
      });
    }
  }

  /* ------------------------------------------------------------ offline ----
     Registers this surface's own service worker: ./sw.js, scoped to the folder
     the page lives in. Each build copies the one file from packages/offline/
     into place, so the front door gets /sw.js and each game its own. See that
     file for what is cached and how.

     The front door's scope, "/", contains every game's folder too, so it is
     told which folders to leave alone through window.PS_OFFLINE_EXCLUDE (the
     shell sets it from its own list of games), passed on the worker's URL.

     After the worker takes over, the page hands it the list of everything it
     loaded before the worker existed, so the FIRST visit is enough to make the
     next one work offline. Any failure here is silent: a browser without
     service workers simply plays online, exactly as before. */
  /* Files a surface wants kept for offline play beyond what its landing page
     loaded -- data fetched only once play begins. Queued until the worker is
     ready, then handed over; safe to call before, during or after start-up. */
  var offlineQueue = [], offlineReg = null;
  function flushOffline() {
    if (!offlineReg || !offlineQueue.length) return;
    var w = navigator.serviceWorker.controller || offlineReg.active;
    if (w) w.postMessage({ type: 'ps-cache', urls: offlineQueue.splice(0) });
  }
  function cacheForOffline(urls) {
    if (!urls || !urls.length) return;
    offlineQueue = offlineQueue.concat(urls);
    flushOffline();
  }

  function offline() {
    if (offline.__done) return;
    offline.__done = true;
    try {
      if (!('serviceWorker' in navigator)) return;
      var h = location.hostname;
      if (location.protocol !== 'https:' && h !== 'localhost' && h !== '127.0.0.1') return;
      var ex = isShell() ? (global.PS_OFFLINE_EXCLUDE || []) : [];
      var url = 'sw.js' + (ex.length ? '?x=' + encodeURIComponent(ex.join(',')) : '');
      navigator.serviceWorker.register(url, { scope: './', updateViaCache: 'none' })
        .then(function () { return navigator.serviceWorker.ready; })
        .then(function (reg) {
          offlineReg = reg;
          var send = function () {
            var urls = [location.href.split('#')[0]];
            try {
              performance.getEntriesByType('resource').forEach(function (e) { urls.push(e.name); });
            } catch (e) { /* no timing API: the page alone is still cached */ }
            cacheForOffline(urls);
          };
          if (document.readyState === 'complete') send();
          else global.addEventListener('load', send);
        })
        .catch(function () { /* blocked, private mode, unsupported: play online */ });
    } catch (e) { /* as above */ }
  }

  /* Links that act like buttons elsewhere on the bar. The Friends link goes
     THROUGH the real Friends button rather than opening the sheet directly, so
     each surface's own Friends handler runs and the gate still applies. */
  function wireLinks() {
    if (wireLinks.__done) return;
    wireLinks.__done = true;
    document.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      if (e.target.closest('[data-open-friends]')) {
        e.preventDefault();
        var f = document.getElementById('friendsBtn'); if (f) f.click();
      } else if (e.target.closest('[data-open-paywall]')) {
        e.preventDefault();
        UI.open('payWall');
      }
    });
  }

  function bar() {
    var a = document.getElementById('psbarBrand');
    if (!a) return;
    var shell = isShell();
    a.setAttribute('href', shell ? '/about/' : '/');
    a.setAttribute('aria-label', shell ? 'About PlaySapien' : 'PlaySapien home');

    if (!bar.__guarded) { bar.__guarded = true; document.addEventListener('click', guard, true); }

    /* Lift the bar's own cards to the top of the page. Each surface inlines
       bar.html wherever its header belongs -- in Word Chain that is INSIDE
       #home, which is position:fixed with z-index 20 and so is a stacking
       context of its own. A card in there can never rise above the page-level
       dimming layer (z 30) however high its own z-index, so the card was dimmed
       along with everything behind it. At the top level the cards share the
       dimming layer's context and sit above it, on every surface, including
       games not written yet. Only these, by id: a game's own sheets are left
       exactly where the game put them. */
    if (!bar.__lifted) {
      bar.__lifted = true;
      ['statsSheet', 'addSheet', 'gateSheet', 'friendsGamesSheet',
       'timedSheet', 'duelSheet', 'payWall', 'profileSheet', 'avPickSheet',
       'downSheet', 'delSheet', 'friendsSheet', 'nameSheet', 'grpDelSheet'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el && el.parentNode !== document.body) document.body.appendChild(el);
      });
    }
    offline();
    wireGate();
    wireProfile();
    wireFriends();
    paintWho();
    wirePromo();
    wireTrial();
    wireNameAsk();
    wireChallenges();
    wireAnalytics();
    wireLinks();

    /* Analytics: one sheet, wired once here, so no surface has to remember to do
       it and none of them can forget. Painted on every open, because the plan
       can change between opens. */
    var sb = document.getElementById('statsBtn');
    if (sb && !sb.__wired) {
      sb.__wired = true;
      sb.addEventListener('click', function () { paintAnalytics(); UI.open('statsSheet'); });
    }

    /* Profile: the same card on every surface, so it is wired here too. The
       devices list is fetched on each open -- it is the one part of the card
       that changes without the player doing anything on this page. */
    var pb = document.getElementById('profileBtn');
    if (pb && !pb.__wired) {
      pb.__wired = true;
      pb.addEventListener('click', function () {
        paintProfile();
        if (ME.user) loadDevices();
        UI.open('profileSheet');
      });
    }

    /* Friends: one card everywhere. The gate (above) already sends anyone
       signed out to sign in before this runs. */
    var fb = document.getElementById('friendsBtn');
    if (fb && !fb.__wired) {
      fb.__wired = true;
      fb.addEventListener('click', function () { loadFriends(); UI.open('friendsSheet'); });
    }

    /* Add. Only the shell is wired here -- in a game this button is that game's
       own "make a puzzle" control and the game binds it itself. */
    var ab = document.getElementById('addBtn');
    if (shell && ab && !ab.__wired) {
      ab.__wired = true;
      ab.addEventListener('click', function () { UI.open('addSheet'); });
    }

    /* Last, so a surface that is about to paint a real avatar has had its
       chance: attnStart bails out on a button already wearing one. */
    attnStart();

    /* Who is signed in. Asked on EVERY surface now, not just the games: the
       gate needs the answer on the front door too, and if the shell's own
       account layer fails to load this is what keeps the gate honest. One
       cookie'd GET per load, and silence on any failure -- which is treated as
       signed out, the safe direction to be wrong in. */
    if (typeof fetch === 'function' && !bar.__asked) {
      bar.__asked = true;
      try {
        fetch('/api/auth/session', { credentials: 'include', headers: { Accept: 'application/json' } })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            var u = j && j.data && j.data.user;
            if (!ME.known) learnUser(u || null);        // the shell may have answered first
            if (u) setUser(u);
          })
          .catch(function () { if (!ME.known) learnUser(null); });
      } catch (e) { if (!ME.known) learnUser(null); }
    }
  }

  global.PSUI = UI;
})(typeof window !== 'undefined' ? window : this);
