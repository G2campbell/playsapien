

/* ==================================================================== 1V1 CHALLENGES
   Two players race to solve the same chain, taking turns (backend/src/lib/duel.js has the
   rules: a turn is a run of right words, it ends at a wrong guess or a Lifeline, and the
   second mover always gets as many turns as the first).

   Everything here is the front of it. THE SERVER KEEPS THE ANSWERS: this game is only ever
   told the words a player has already solved, plus the first letter of the one they are on,
   and each guess is sent to the server to be judged. So a 1v1 turn needs a connection, and
   nobody can cheat by looking.

   The pieces:
     - the list (the shared duelSheet): games waiting on you first, then the rest, and the
       badge on the 1v1 button that counts them;
     - the way in: who -> which puzzle -> sent (or, for a new puzzle, the composer and then
       "send it / choose another / make another / cancel");
     - playing a turn, on the ordinary board, with the hooks in part-c-app.js (S.mode 'duel'). */

var DU = { games: [], friends: [], to: null, busy: false, signedOut: false, fromComposer: false, kind: 'duel' };

var DU_ERR = {
  sapien_required: 'Starting a challenge is part of Sapien.',
  too_many_games: 'You have a lot of games going. Finish a few first.',
  too_fast: 'That time is not one this game can have taken.',
  too_long: 'That time is not one this game can have taken.',
  not_started: 'Open the chain first.',
  not_solved: 'That chain was not solved.',
  bad_moves: 'Those moves could not be checked.',
  already_finished: 'You have already finished this one.',
  already_started: 'That has already started.',
  too_many_with_friend: 'You already have five games going with them.',
  bad_chain: 'That puzzle cannot be used. A puzzle needs 4 to 12 words, letters only.',
  bad_invite: 'Type an email address or an 8-character invite code.',
  bad_code: 'That invite code does not work.',
  bad_email: 'That does not look like an email address.',
  self: 'That is you.',
  not_friends: 'That player is not your friend.',
  rate_limited: 'That is a lot for one day. Try again tomorrow.',
  not_your_turn: 'It is not your turn.',
  not_active: 'That game is over.',
  busy: 'That did not go through. Try again.',
  offline: 'Could not reach the server. Try again.'
};
function duMsg(code) { return DU_ERR[code] || 'Something went wrong. Try again.'; }
function duEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/* One call to the server, always resolving to { ok, status, data, error }. */
function duApi(method, path, body) {
  return loadPS().then(function (PS) {
    if (!PS) return { ok: false, status: 0, data: null, error: 'offline' };
    return method === 'GET' ? PS.get(path) : PS.send(path, body);
  });
}
function duAvatar(u) {
  return '<span class="psav">' + (u ? PSUI.avatar(u) : '<span class="psav-ltr">?</span>') + '</span>';
}

/* ------------------------------------------------------------------ the list + badge */
function duelRefresh() {
  if (DU.signedOut) return Promise.resolve();
  return duApi('GET', '/duels').then(function (r) {
    if (r.status === 401) { DU.signedOut = true; DU.games = []; paintTurnBadge(0); }
    else if (r.ok && r.data) { DU.games = r.data.games || []; paintTurnBadge(r.data.yourTurn || 0); }
    paintDuelList();
  });
}

function duRow(g) {
  var opp = g.opponent, name = duEsc(opp ? opp.name : (g.waitingOn || 'your friend'));
  var total = g.n - 1, cls = 'dl-row', sub = '', act = '';
  var prog = 'you ' + g.mySolved + ' of ' + total + ' · them ' + g.theirSolved;
  if (g.state === 'done') {
    var chip = g.result === 'win' ? 'won' : g.result === 'loss' ? 'lost' : 'drew';
    sub = (g.result === 'win' ? 'You beat ' : g.result === 'loss' ? name + ' beat you' : 'A draw with ') +
          (g.result === 'loss' ? '' : name);
    act = '<span class="dl-chip ' + (g.result === 'win' ? 'win' : '') + '">' + chip + '</span>' +
          '<button class="btn ghost" data-act="view">View</button>';
  } else if (g.state === 'invited') {
    if (g.needsFriendAccept) {
      sub = name + ' challenged you. Accept their friend request to play.';
      act = '<button class="btn" data-act="accept">Accept</button><button class="btn ghost" data-act="cancel">Decline</button>';
    } else {
      sub = 'Waiting for ' + name + ' to join and accept.';
      act = '<button class="btn ghost" data-act="cancel">Withdraw</button>';
    }
  } else if (g.yourTurn) {
    cls += ' turn';
    sub = 'Your move · ' + prog;
    act = '<button class="btn" data-act="play">Play</button>';
  } else {
    sub = 'Waiting for ' + name + ' · ' + prog;
    act = '<button class="btn ghost" data-act="resign">Resign</button>';
  }
  return '<div class="' + cls + '" data-id="' + duEsc(g.id) + '">' + duAvatar(opp) +
    '<div class="dl-main"><div class="dl-name">' + 'vs ' + name +
    '</div><div class="dl-sub">' + sub + '</div></div><div class="dl-act">' + act + '</div></div>';
}

function paintDuelList() {
  var box = $('duelList'); if (!box) return;
  var groups = [
    ['Your turn', function (g) { return g.state === 'active' && g.yourTurn; }],
    ['Their turn', function (g) { return g.state === 'active' && !g.yourTurn; }],
    ['Invitations', function (g) { return g.state === 'invited'; }],
    ['Finished', function (g) { return g.state === 'done'; }]
  ];
  var out = [];
  groups.forEach(function (gr) {
    var rows = DU.games.filter(gr[1]);
    if (!rows.length) return;
    out.push('<div class="mine-head">' + gr[0] + '</div>');
    rows.forEach(function (g) { out.push(duRow(g)); });
  });
  box.innerHTML = out.join('');
}

$('duelBtn').addEventListener('click', function () { paintDuelList(); duelRefresh(); });
$('duelList').addEventListener('click', function (e) {
  var btn = e.target.closest('button[data-act]'); if (!btn) return;
  var row = btn.closest('.dl-row'), id = row.getAttribute('data-id'), act = btn.getAttribute('data-act');
  var g = DU.games.filter(function (x) { return x.id === id; })[0];
  if (!g) return;
  if (act === 'play') duelOpen(id);
  else if (act === 'view') duelViewResult(id);
  else if (act === 'resign') {
    ask('Resign this game? ' + (g.opponent ? g.opponent.name : 'They') + ' wins.', 'Yes, resign', function () {
      duApi('POST', '/duels/' + id + '/resign').then(function (r) {
        if (!r.ok) PSUI.toast(duMsg(r.error)); duelRefresh();
      });
    });
  } else if (act === 'cancel') {
    duApi('POST', '/duels/' + id + '/cancel').then(function (r) {
      if (!r.ok) PSUI.toast(duMsg(r.error)); duelRefresh();
    });
  } else if (act === 'accept' && g.opponent) {
    /* Saying yes to the friend request is what lets the game start. */
    duApi('POST', '/player/friends/' + g.opponent.id + '/accept').then(function (r) {
      PSUI.toast(r.ok ? 'You are friends. Your move.' : duMsg(r.error)); duelRefresh();
    });
  }
});

/* ------------------------------------------------------------------ the way in */
function duelStart(kind) {
  DU.kind = kind || 'duel';
  DU.to = null; DU.fromComposer = false;
  $('duelInvite').value = '';
  $('duelFriends').innerHTML = '<p class="sethint">Loading…</p>';
  PSUI.open('duelWho');
  duApi('GET', '/player/friends').then(function (r) {
    var list = (r.ok && r.data && r.data.accepted) || [];
    DU.friends = list;
    $('duelFriends').innerHTML = list.length ? list.map(function (f) {
      return '<button class="dl-friend" data-id="' + duEsc(f.id) + '">' + duAvatar(f) +
        '<span class="dl-name">' + duEsc(f.display_name || f.handle || 'Player') + '</span></button>';
    }).join('') : '<div class="fr-empty">No friends yet. Invite someone below.</div>';
  });
}
$('duelNew').setAttribute('data-live', '1');          /* the shared "coming soon" stands aside */
$('duelNew').addEventListener('click', function () { duelStart('duel'); });

$('duelFriends').addEventListener('click', function (e) {
  var b = e.target.closest('.dl-friend'); if (!b) return;
  var f = DU.friends.filter(function (x) { return x.id === b.getAttribute('data-id'); })[0];
  if (!f) return;
  DU.to = { friend_id: f.id, name: f.display_name || f.handle || 'your friend' };
  if (DU.kind === 'timed') createTimed(); else duelWhich();
});
function duelInviteNext() {
  var v = ($('duelInvite').value || '').trim();
  if (!v) { PSUI.toast('Type an email address or invite code first.'); return; }
  DU.to = { invite: v, name: v };
  if (DU.kind === 'timed') createTimed(); else duelWhich();
}
$('duelInviteGo').addEventListener('click', duelInviteNext);
$('duelInvite').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); duelInviteNext(); }
});

function duelWhich() {
  $('duelWhatWho').textContent = 'Challenging ' + DU.to.name + '.';
  var have = puzzles().length;
  $('duelMineBtn').disabled = !have;
  $('duelMineBtn').textContent = have ? 'Share one of mine' : 'Share one of mine (you have none yet)';
  PSUI.open('duelWhat');
}
$('duelPick').addEventListener('click', function () { createDuel({ source: 'practice' }, false); });
$('duelMineBtn').addEventListener('click', function () { DU.fromComposer = false; paintDuelMine(); PSUI.open('duelMineSheet'); });
$('duelMake').addEventListener('click', function () { PSUI.close(); composeOpen(null, { duel: DU.to }); });

function paintDuelMine() {
  var mine = puzzles();
  $('duelMineBody').innerHTML = mine.length ? mine.map(function (p) {
    var rest = p.words.slice(1).map(function (w) { return w[0]; }).join(', ');
    return '<button class="dl-puz" data-id="' + duEsc(p.id) + '"><div class="mine-first">' + duEsc(p.words[0]) +
      ' <span style="opacity:.4">|</span> <span style="font-weight:400">' + duEsc(rest) + '</span></div></button>';
  }).join('') : '<div class="fr-empty">No puzzles yet.</div>';
}
$('duelMineBody').addEventListener('click', function (e) {
  var b = e.target.closest('.dl-puz'); if (!b) return;
  var p = puzzles().filter(function (x) { return x.id === b.getAttribute('data-id'); })[0];
  if (p) createDuel({ source: 'mine', words: p.words.slice() }, DU.fromComposer);
});

/* Send it. From the composer, sending (like cancelling) leaves the area for the start screen. */
function createDuel(chain, fromComposer) {
  if (DU.busy || !DU.to) return;
  DU.busy = true;
  var to = DU.to.friend_id ? { friend_id: DU.to.friend_id } : { invite: DU.to.invite };
  duApi('POST', '/duels', { to: to, chain: chain }).then(function (r) {
    DU.busy = false;
    if (!r.ok) { PSUI.toast(duMsg(r.error)); return; }
    var who = DU.to.name; var invited = !!DU.to.invite;
    PSUI.close();
    if (fromComposer) composeClose();
    DU.to = null; DU.fromComposer = false;
    PSUI.toast(invited ? 'Invitation sent. Your challenge starts when they join and accept.'
                       : 'Challenge sent to ' + who + '.');
    duelRefresh();
  });
}

/* A puzzle was just made for a challenge: what now? (called from the composer's save) */
function duelSaved() {
  $('duelSavedWho').textContent = 'For ' + C.duel.name + '.';
  $('duelSavedOther').hidden = puzzles().length < 2;
  PSUI.open('duelSaved');
}
$('duelSavedSend').addEventListener('click', function () {
  if (C) createDuel({ source: 'mine', words: C.words.slice() }, true);
});
$('duelSavedOther').addEventListener('click', function () {
  DU.fromComposer = true; paintDuelMine(); PSUI.open('duelMineSheet');
});
$('duelSavedMake').addEventListener('click', function () {
  var to = C && C.duel; PSUI.close(); if (to) composeOpen(null, { duel: to });
});
$('duelSavedCancel').addEventListener('click', function () { PSUI.close(); DU.to = null; composeClose(); });

/* ------------------------------------------------------------------ playing a turn */
function duelBoard(g) {
  var n = g.n, words = [], revealed = [], perWord = [], k, p;
  for (k = 0; k < n; k++) {
    if (k < g.mine.pos) { words.push(g.mine.solved[k]); revealed.push(g.mine.solved[k].length); }
    else if (k === g.mine.pos) {
      p = g.mine.prefix || '';
      words.push(p); revealed.push(p.length); perWord[k] = Math.max(0, p.length - 1);
    } else { words.push(''); revealed.push(0); }
  }
  return { words: words, revealed: revealed, perWord: perWord, i: g.mine.pos,
           hintsThisWord: Math.max(0, (g.mine.prefix || '').length - 1), tried: (g.mine.tried || []).slice() };
}

function duelLabel() {
  $('mode').textContent = 'vs ' + S.oppName + ' · ' + Math.max(0, S.theirs.solvedCount) + '/' + (S.n - 1);
}

function duelOpen(id) {
  duApi('GET', '/duels/' + id).then(function (r) {
    if (!r.ok) { PSUI.toast(duMsg(r.error)); duelRefresh(); return; }
    var g = r.data;
    if (g.state === 'done') { duelResult(g, true); return; }
    if (g.state !== 'active' || !g.yourTurn || g.mine.finished) {
      PSUI.toast('Waiting for ' + (g.opponent ? g.opponent.name : 'them') + '.'); duelRefresh(); return;
    }
    PSUI.close();
    var b = duelBoard(g);
    S = {
      mode: 'duel', duelId: g.id, oppName: g.opponent ? g.opponent.name : 'your friend', n: g.n, theirs: g.theirs,
      words: b.words, links: [], i: b.i, day: todayKey(), revealed: b.revealed, hintsThisWord: b.hintsThisWord,
      hintCount: 0, penaltyMs: 0, frozenMs: 0, perWord: b.perWord, wordMs: [], wrongThisWord: 0, tried: b.tried,
      t0: Date.now(), wordT0: Date.now(), locked: false, done: false, finals: [], run: null
    };
    show('duel');
  });
}

/* The ordinary board's classify(), for a duel: the server judges. The flavour of a wrong
   guess (a real pair, a stretch, or nothing) is still the game's own, from its pairs list. */
function duelClassify(guess) {
  if (!guess) return Promise.resolve({ b: null });
  if (S.tried.indexOf(guess) >= 0) return Promise.resolve({ b: 'repeat' });
  return duApi('POST', '/duels/' + S.duelId + '/guess', { guess: guess }).then(function (r) {
    if (!r.ok) {
      if (r.error === 'not_your_turn' || r.error === 'not_active') { PSUI.toast(duMsg(r.error)); duelLeave(); }
      else setMsg(duMsg(r.error), null);
      return { b: null };
    }
    var d = r.data, map = { correct: 'correct', number: 'number', repeat: 'repeat', notword: 'notword', letter: 'letter' };
    if (d.outcome === 'wrong') return { b: localVerdict(S.words[S.i - 1], guess), server: d };
    return { b: map[d.outcome] || 'weak', server: d };
  });
}

/* A Lifeline in a duel: the server reveals the next letter, and the turn ends. */
function duelHint() {
  if (S.locked || S.done) return;
  S.locked = true; setInput(false);
  duApi('POST', '/duels/' + S.duelId + '/hint').then(function (r) {
    if (!r.ok) { setMsg(duMsg(r.error), null); S.locked = false; setInput(true); updateHintBtn(); return; }
    duelApply(r.data.game, 'hint');
  });
}

/* Take what the server says as the new state of the board. */
function duelApply(g, why) {
  if (g.opponent && g.opponent.name) S.oppName = g.opponent.name;
  var b = duelBoard(g);
  S.words = b.words; S.revealed = b.revealed; S.perWord = b.perWord; S.i = b.i;
  S.hintsThisWord = b.hintsThisWord; S.tried = b.tried; S.theirs = g.theirs; S.n = g.n;
  typed = '';
  var ended = g.state === 'done' || !g.yourTurn || g.mine.finished;
  if (ended) { S.done = true; S.locked = true; }          // so the board behind the card is tidy too
  renderChain();
  if (g.state === 'done') { duelResult(g, false); return; }
  if (ended) { duelTurnOver(g, why); return; }
  updateHintBtn(); duelLabel();
  S.locked = false; setInput(true);
}

/* The overlay the finished-game card uses, with this game's words on it. */
function duelOverlay(title, line, brk, words) {
  var h2 = document.querySelector('#results h2'); if (h2) h2.textContent = title;
  $('resLine').innerHTML = line;
  $('resBreak').textContent = brk || '';
  $('resChain').innerHTML = words && words.length ? chainHTML(words, []) : '';
  $('shareBtn').hidden = true;
  $('againBtn').className = 'btn';
  $('results').classList.add('on');
}

function duelTurnOver(g, why) {
  S.done = true; S.locked = true; setInput(false);
  var opp = duEsc(S.oppName), solved = g.mine.solved.length - 1, total = g.n - 1;
  var words = g.mine.solved.concat(g.mine.prefix ? [g.mine.prefix] : []);
  var title = 'Turn over', line, brk;
  if (g.mine.finished) {
    title = 'Chained!';
    line = 'You finished the chain.';
    brk = opp + ' has one turn left to tie it. You will see their result here.';
  } else {
    line = why === 'hint' ? 'You used a Lifeline: the next letter is shown, and your turn ends.' : 'Not that one. Your turn ends.';
    brk = 'You have solved ' + solved + ' of ' + total + '. ' + S.oppName + ' is next. A number on the 1v1 button tells you when it is your move again.';
  }
  duelOverlay(title, line, brk, words);
  duelRefresh();
}

function duelResult(g, fromList) {
  var opp = (g.opponent && g.opponent.name) || (S && S.oppName) || 'your friend';
  if (S && S.mode === 'duel') { S.done = true; S.locked = true; setInput(false); }
  var title, line, brk;
  if (g.result === 'win') { title = 'You won!'; line = 'You beat ' + duEsc(opp) + '.'; brk = 'Nicely done.'; }
  else if (g.result === 'draw') { title = 'A draw'; line = 'You and ' + duEsc(opp) + ' finished together.'; brk = 'Rematch?'; }
  else { title = 'You lost'; line = duEsc(opp) + ' won this one.'; brk = 'The chain is below. Challenge them again.'; }
  duelOverlay(title, line, brk, g.chain);
  if (!fromList) duelRefresh();
}
function duelViewResult(id) {
  duApi('GET', '/duels/' + id).then(function (r) {
    if (r.ok && r.data.state === 'done') { PSUI.close(); duelResult(r.data, true); }
    else PSUI.toast(r.ok ? 'That game is not over yet.' : duMsg(r.error));
  });
}

/* Leaving a game mid-turn costs nothing: the server holds it exactly where it was. */
function duelLeave() { goHome(); duelRefresh(); }

/* ------------------------------------------------------------------ keeping the badge fresh */
document.addEventListener('ps:user', function (e) {
  DU.signedOut = !e.detail;
  if (e.detail) { duelRefresh(); timedRefresh(); } else { DU.games = []; TC.games = []; paintTurnBadge(0); paintTimedBadge(0); }
});
window.addEventListener('focus', function () { duelRefresh(); timedRefresh(); });
setInterval(function () { if (!document.hidden) { duelRefresh(); timedRefresh(); } }, 90000);
setTimeout(function () { duelRefresh(); timedRefresh(); }, 3000);
