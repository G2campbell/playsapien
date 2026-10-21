

/* ==================================================================== TIMED FRIEND CHALLENGES
   Two players are given the SAME chain and each runs it on their own time, on the ordinary timed
   board. The faster time wins; times that read the same to the second are a draw. Nobody sees the
   other's time until they have finished themselves.

   The server hands out the chain when a player first opens it (and starts that player's clock on
   its own books, so a claimed time can never be longer than the time that passed), checks that the
   chain was solved, works out the Lifeline penalty itself and decides who won (backend/src/routes/
   timed.js). The time that counts is this game's own clock: a pause never costs anyone anything.

   The pieces here: the list on the shared timed panel, the badge on the Timed button, the way in
   (the same friend picker as the 1v1 -- duel.js -- then straight to sent), playing (the ordinary
   board with S.mode 'timed', hooked in part-c-app.js), and sending the result, which waits and
   retries if there is no connection. */

var TC = { games: [] };

function tcDiff(ms) {                       // "+4:10": faster by that much; "-4:10": slower
  var t = Math.round(Math.abs(ms) / 1000);
  return (ms < 0 ? '-' : '+') + Math.floor(t / 60) + ':' + ('0' + (t % 60)).slice(-2);
}

/* How far apart two times were, to the nearest second and never "0:00" for a result that was not
   a draw. The same rounding the Analytics differential uses, so the two always agree. */
function tcGap(ms) {
  var t = Math.max(1, Math.round(Math.abs(ms) / 1000));
  return Math.floor(t / 60) + ':' + ('0' + (t % 60)).slice(-2);
}

function paintTimedBadge(n) {
  var b = $('timedBadge');
  if (!b) return;
  b.textContent = n > 9 ? '9+' : String(n);
  b.hidden = !n;
  b.setAttribute('aria-label', n === 1 ? '1 timed challenge awaiting your run' : n + ' timed challenges awaiting your run');
  b.setAttribute('aria-hidden', n ? 'false' : 'true');
}

function timedRefresh() {
  if (DU.signedOut) return Promise.resolve();
  return duApi('GET', '/timed').then(function (r) {
    if (r.status === 401) { DU.signedOut = true; TC.games = []; paintTimedBadge(0); }
    else if (r.ok && r.data) { TC.games = r.data.games || []; paintTimedBadge(r.data.yourTurn || 0); }
    paintTimedList();
  });
}

function tcRow(g) {
  var opp = g.opponent, name = duEsc(opp ? opp.name : (g.waitingOn || 'your friend'));
  var cls = 'dl-row', sub = '', act = '';
  if (g.state === 'done') {
    var chip = g.result === 'win' ? 'won' : g.result === 'loss' ? 'lost' : 'drew';
    sub = g.result === 'draw'
      ? 'A draw, ' + fmt(g.mineMs) + ' each'
      : (g.result === 'win' ? 'You won by ' : 'You lost by ') + tcGap(g.diffMs) +
        ' · ' + fmt(g.mineMs) + ' to ' + fmt(g.theirMs);
    act = '<span class="dl-chip ' + (g.result === 'win' ? 'win' : '') + '">' + chip + '</span>';
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
    sub = (g.theirsFinished ? name + ' has finished. ' : '') + (g.started ? 'You have started. Pick it up again.' : 'Your run.');
    act = '<button class="btn" data-act="play">' + (g.started ? 'Resume' : 'Play') + '</button>';
  } else {
    sub = 'You finished in ' + fmt(g.mineMs) + '. Waiting for ' + name + '.';
  }
  return '<div class="' + cls + '" data-id="' + duEsc(g.id) + '">' + duAvatar(opp) +
    '<div class="dl-main"><div class="dl-name">vs ' + name + '</div><div class="dl-sub">' + sub + '</div></div>' +
    '<div class="dl-act">' + act + '</div></div>';
}

function paintTimedList() {
  var box = $('timedList'); if (!box) return;
  var groups = [
    ['Your run', function (g) { return g.state === 'active' && g.yourTurn; }],
    ['Waiting', function (g) { return g.state === 'active' && !g.yourTurn; }],
    ['Invitations', function (g) { return g.state === 'invited'; }],
    ['Finished', function (g) { return g.state === 'done'; }]
  ];
  var out = [];
  groups.forEach(function (gr) {
    var rows = TC.games.filter(gr[1]);
    if (!rows.length) return;
    out.push('<div class="mine-head">' + gr[0] + '</div>');
    rows.forEach(function (g) { out.push(tcRow(g)); });
  });
  box.innerHTML = out.join('');
}

$('timedBtn').addEventListener('click', function () { paintTimedList(); timedRefresh(); });
$('timedNew').setAttribute('data-live', '1');          /* the shared "coming soon" stands aside */
$('timedNew').addEventListener('click', function () { duelStart('timed'); });

$('timedList').addEventListener('click', function (e) {
  var btn = e.target.closest('button[data-act]'); if (!btn) return;
  var id = btn.closest('.dl-row').getAttribute('data-id'), act = btn.getAttribute('data-act');
  var g = TC.games.filter(function (x) { return x.id === id; })[0];
  if (!g) return;
  if (act === 'play') {
    PSUI.close();
    startGame('timed', { id: id, opp: g.opponent ? g.opponent.name : 'your friend' });
  } else if (act === 'cancel') {
    duApi('POST', '/timed/' + id + '/cancel').then(function (r) {
      if (!r.ok) PSUI.toast(duMsg(r.error)); timedRefresh();
    });
  } else if (act === 'accept' && g.opponent) {
    duApi('POST', '/player/friends/' + g.opponent.id + '/accept').then(function (r) {
      PSUI.toast(r.ok ? 'You are friends. Your run.' : duMsg(r.error)); timedRefresh();
    });
  }
});

/* ------------------------------------------------------------------ the way in */
/* The friend picker (duel.js) calls this for a timed challenge: no puzzle to choose, the game
   deals the same chain to both from the practice pile. */
function createTimed() {
  if (DU.busy || !DU.to) return;
  DU.busy = true;
  var to = DU.to.friend_id ? { friend_id: DU.to.friend_id } : { invite: DU.to.invite };
  duApi('POST', '/timed', { to: to }).then(function (r) {
    DU.busy = false;
    if (!r.ok) { PSUI.toast(duMsg(r.error)); return; }
    var who = DU.to.name, invited = !!DU.to.invite;
    PSUI.close();
    DU.to = null;
    PSUI.toast(invited ? 'Invitation sent. Your challenge starts when they join and accept.'
                       : 'Timed challenge sent to ' + who + '. Run yours whenever you like.');
    timedRefresh();
  });
}

/* ------------------------------------------------------------------ finishing */
/* The run is over: show the time, and send how it was solved. If there is no connection it is
   kept, and sent the next time the game opens or comes back online. */
function timedFinish(total, base) {
  var id = S.chalId, opp = S.oppName, moves = movesOf(S, base);
  drop('game:timed'); HELD.timed = null;
  $('resLine').innerHTML = 'You finished in <b>' + fmt(total) + '</b>.';
  $('resBreak').textContent = S.hintCount
    ? 'base ' + fmt(base) + '  ·  ' + S.hintCount + ' lifeline' + (S.hintCount > 1 ? 's' : '') + ' +' + Math.round(S.penaltyMs / 1000) + 's'
    : 'no lifelines';
  $('resChain').innerHTML = chainHTML(S.words, S.perWord);
  $('shareBtn').hidden = true;
  $('againBtn').className = 'btn';
  setTimeout(function () { $('results').classList.add('on'); }, 420);
  sendTimed(id, moves, opp);
}

function sendTimed(id, moves, opp) {
  store('timedpending:' + id, { moves: moves, opp: opp });
  return duApi('POST', '/timed/' + id + '/finish', { moves: moves }).then(function (r) {
    if (r.ok) { drop('timedpending:' + id); timedShow(r.data, opp); timedRefresh(); return; }
    if (r.error === 'offline' || r.error === 'timeout' || !r.status || r.status >= 500) {
      PSUI.toast('Saved. It will be sent when you are back online.');
      return;
    }
    drop('timedpending:' + id);                        /* a refusal that will not change */
    if (r.error !== 'already_finished') PSUI.toast(duMsg(r.error));
    timedRefresh();
  });
}

/* What the server says, on the card the player is already looking at. */
function timedShow(d, opp) {
  var line = $('resLine'); if (!line) return;
  var o = duEsc(opp || 'your friend');
  var head = 'You finished in <b>' + fmt(d.mineMs) + '</b>. ';
  if (!d.theirsFinished) line.innerHTML = head + o + ' has not finished yet. You will see the result here when they do.';
  else if (d.result === 'draw') line.innerHTML = head + 'A draw with ' + o + '.';
  else if (d.result === 'win') line.innerHTML = head + 'You beat ' + o + ' by <b>' + tcGap(d.diffMs) + '</b>.';
  else line.innerHTML = head + o + ' beat you by <b>' + tcGap(d.diffMs) + '</b>.';
}

/* Results that could not be sent last time. */
function resendTimed() {
  try {
    var ls = window.localStorage, keys = [], i, m;
    for (i = 0; i < ls.length; i++) {
      m = /^wordchain:timedpending:(.+)$/.exec(ls.key(i) || '');
      if (m) keys.push(m[1]);
    }
    keys.forEach(function (id) {
      var p = store('timedpending:' + id);
      if (p && p.moves) sendTimed(id, p.moves, p.opp);
    });
  } catch (e) {}
}
window.addEventListener('online', resendTimed);
