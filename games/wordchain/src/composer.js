
/* ==================================================================== COMPOSER
   Making a chain is a working task, not a dialog, so it gets a page of its own with
   the same three zones and the same keyboard as the board. The only differences are
   that every row is editable, in any order, and there is no clock to run. */

var C = null;                       /* the chain being written */
var confirmYes = null;              /* what a Yes on the shared confirm dialog does */

function puzzles() { return store('puzzles') || []; }
function archive() { return store('archive') || []; }
function friends() { return store('friends') || []; }
function newId() { return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }

function composeOpen(src) {
  C = {
    words: src ? src.words.slice() : ['', '', '', '', '', '', '', ''],
    row: 0, sourceId: src ? src.id : null,
    savedId: null, shareId: src ? src.id : null, dirty: false
  };
  $('cTitle').textContent = src ? 'Editing' : 'New chain';
  $('home').hidden = true; $('app').hidden = true; $('compose').hidden = false;
  mountKeyboard($('compose'));
  cRender(); cHint('');
}

function composeClose() {
  $('compose').hidden = true; $('home').hidden = false;
  C = null; PSUI.close(); mountKeyboard($('app')); paintHome();
}

function cValid() { return C.words.every(function (w) { return w.length >= 3; }); }
function cCanSave() { return cValid() && (C.dirty || (!C.savedId && !C.sourceId)); }

function cHint(text, warn) {
  var h = $('cHint');
  h.className = warn ? 'warn' : '';
  h.textContent = text || 'Tap a row to edit it. Every row needs a word of at least three letters.';
  if (text) {
    clearTimeout(cHint._t);
    cHint._t = setTimeout(function () { cHint(''); }, 2800);
  }
}

function cRender() {
  var box = $('cRows'); box.innerHTML = '';
  C.words.forEach(function (w, k) {
    var row = document.createElement('div');
    row.className = 'crow' + (k === C.row ? ' on' : '') + (w.length && w.length < 3 ? ' short' : '');
    row.dataset.row = k;
    var n = document.createElement('span'); n.className = 'num'; n.textContent = (k + 1);
    var wd = document.createElement('span'); wd.className = 'cword';
    for (var j = 0; j < w.length; j++) {
      var ch = document.createElement('span'); ch.className = 'ch'; ch.textContent = w[j]; wd.appendChild(ch);
    }
    row.appendChild(n); row.appendChild(wd);
    if (k === C.row) { var c = document.createElement('span'); c.className = 'ccaret'; row.appendChild(c); }
    box.appendChild(row);
  });
  var save = $('cSaveBtn'), share = $('cShareBtn');
  /* greyed, but still clickable - a dead button cannot explain itself */
  save.classList.toggle('off', !cCanSave());
  share.classList.toggle('off', !C.shareId);
}

function cPress(k) {
  if (k === 'ENTER') { C.row = (C.row + 1) % 8; cRender(); return; }
  if (k === 'DEL') {
    if (C.words[C.row]) { C.words[C.row] = C.words[C.row].slice(0, -1); cMutated(); }
    return;
  }
  if (C.words[C.row].length >= 14) return;
  C.words[C.row] += k; cMutated();
}
function cMutated() {
  C.dirty = true;
  C.shareId = null;              /* an edited chain is not the saved one any more */
  C.savedId = null;
  cRender();
}

function cSave() {
  if (!cValid()) { cHint('Each row must contain a word of at least three letters.', true); return; }
  if (!cCanSave()) { cHint('This puzzle has already been saved.', true); return; }
  var p = { id: newId(), words: C.words.slice(), created: Date.now(), shared: [] };
  var all = puzzles(); all.unshift(p); store('puzzles', all);
  C.savedId = p.id; C.shareId = p.id; C.dirty = false; C.sourceId = null;
  $('cTitle').textContent = 'Saved';
  cRender(); cHint('Saved.');
}

/* ------------------------------------------------------------------ my chains */
function mineRowHTML(p, archived) {
  var rest = p.words.slice(1).map(function (w) { return w[0]; }).join(', ');
  return '<div class="mine-row" data-id="' + p.id + '">' +
    '<div class="mine-txt"><div class="mine-first">' + p.words[0] +
    ' <span style="opacity:.4">|</span> <span style="font-weight:400">' + rest + '</span></div>' +
    '<div class="mine-rest">' + (p.shared && p.shared.length
      ? 'sent to ' + p.shared.length + (p.shared.length > 1 ? ' people' : ' person')
      : 'not sent') + '</div></div>' +
    (archived ? '<span class="mine-tag">kept</span>' :
      '<div class="mine-acts">' +
      '<button class="iconbtn" data-act="edit" aria-label="Edit"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17h4l9-9a2.5 2.5 0 0 0-3.5-3.5l-9 9v3.5"/><path d="M12.5 6.5l3.5 3.5"/><path d="M14 17h7M14 20h7"/></svg></button>' +
      '<button class="iconbtn" data-act="send" aria-label="Send"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14l11-11"/><path d="M21 3l-6.5 18a.55.55 0 0 1-1 0l-3.5-7l-7-3.5a.55.55 0 0 1 0-1l18-6.5"/></svg></button>' +
      '<button class="iconbtn danger" data-act="del" aria-label="Delete"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/></svg></button>' +
      '</div>') + '</div>';
}
function paintMine() {
  var mine = puzzles(), arch = archive(), out = [];
  if (!mine.length && !arch.length) {
    out.push('<div class="fr-empty">No chains yet. Close this and write one.</div>');
  } else {
    mine.forEach(function (p) { out.push(mineRowHTML(p, false)); });
    if (arch.length) {
      out.push('<div class="mine-head">Deleted, but already sent</div>');
      out.push('<p class="sethint" style="margin:0 0 4px">These were deleted after being sent, so they are kept — someone else may still be playing them.</p>');
      arch.forEach(function (p) { out.push(mineRowHTML(p, true)); });
    }
  }
  $('mineBody').innerHTML = out.join('');
}

function deletePuzzle(id) {
  var all = puzzles(), keep = [], gone = null;
  all.forEach(function (p) { if (p.id === id) gone = p; else keep.push(p); });
  if (!gone) return;
  store('puzzles', keep);
  if (gone.shared && gone.shared.length) {
    var a = archive(); gone.deletedAt = Date.now(); a.unshift(gone); store('archive', a);
  }
  paintMine();
}

/* ------------------------------------------------------------------ send to */
var sendTarget = null, checked = {};
function openSend(id) {
  sendTarget = id; checked = {};
  $('friendFind').value = '';
  paintFriends(); PSUI.open('shareSheet');
}
function paintFriends() {
  var q = ($('friendFind').value || '').trim().toLowerCase();
  var list = friends().filter(function (f) { return !q || f.name.toLowerCase().indexOf(q) >= 0; });
  var tick = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>';
  if (!list.length) {
    $('friendList').innerHTML = '<div class="fr-empty">' + (q
      ? 'No one by that name yet. Press + to add <b>' + q + '</b>.'
      : 'No friends or groups yet. Type a name above and press + to add one.') + '</div>';
  } else {
    $('friendList').innerHTML = list.map(function (f) {
      return '<div class="fr-row" role="checkbox" aria-checked="' + (checked[f.id] ? 'true' : 'false') +
        '" data-id="' + f.id + '"><span class="fr-box">' + tick + '</span>' +
        '<span class="fr-name">' + f.name + '</span>' +
        '<span class="fr-kind">' + (f.kind === 'group' ? 'group' : 'friend') + '</span></div>';
    }).join('');
  }
  var n = Object.keys(checked).filter(function (k) { return checked[k]; }).length;
  $('sendBtn').disabled = !n;
  $('sendBtn').textContent = n ? 'Send to ' + n : 'Send';
}
function doSend() {
  var ids = Object.keys(checked).filter(function (k) { return checked[k]; });
  if (!ids.length || !sendTarget) return;
  var all = puzzles(), hit = null;
  all.forEach(function (p) { if (p.id === sendTarget) hit = p; });
  if (hit) {
    hit.shared = hit.shared || [];
    ids.forEach(function (i) { if (hit.shared.indexOf(i) < 0) hit.shared.push(i); });
    store('puzzles', all);
  }
  PSUI.close(); paintMine();
  PSUI.toast('Sent to ' + ids.length + (ids.length > 1 ? ' people' : ''));
}

/* ------------------------------------------------------------------ confirm */
function ask(question, yesLabel, onYes) {
  $('confirmQ').textContent = question;
  $('confirmYes').textContent = yesLabel;
  confirmYes = onYes;
  $('confirm').hidden = false;
}
function closeConfirm() { $('confirm').hidden = true; confirmYes = null; }

/* ------------------------------------------------------------------ wiring */
$('composeBtn').addEventListener('click', function () { composeOpen(null); });
$('cHomeBtn').addEventListener('click', function () {
  var unsaved = C && C.dirty && C.words.some(function (w) { return w.length; });
  if (!unsaved) { composeClose(); return; }
  ask('Leave without saving this chain?', 'Yes, discard it', composeClose);
});
$('cListBtn').addEventListener('click', function () { paintMine(); PSUI.open('mineSheet'); });
$('cSaveBtn').addEventListener('click', cSave);
$('cShareBtn').addEventListener('click', function () {
  if (!C.shareId) { cHint('Save the chain before sending it.', true); return; }
  openSend(C.shareId);
});
$('cRows').addEventListener('click', function (e) {
  var r = e.target.closest('.crow'); if (!r) return;
  C.row = +r.dataset.row; cRender();
});
$('mineBody').addEventListener('click', function (e) {
  var btn = e.target.closest('[data-act]'); if (!btn) return;
  var id = btn.closest('.mine-row').dataset.id, p = null;
  puzzles().forEach(function (q) { if (q.id === id) p = q; });
  if (!p) return;
  if (btn.dataset.act === 'edit') { PSUI.close(); composeOpen(p); }
  else if (btn.dataset.act === 'send') openSend(id);
  else ask('Delete this chain?', 'Yes, delete it', function () { closeConfirm(); deletePuzzle(id); });
});
$('friendFind').addEventListener('input', paintFriends);
$('friendAdd').addEventListener('click', function () {
  var name = ($('friendFind').value || '').trim();
  if (!name) return;
  var f = { id: 'f' + Date.now().toString(36), name: name, kind: /s$|team|group|club|family/i.test(name) ? 'group' : 'person' };
  var all = friends(); all.push(f); store('friends', all);
  $('friendFind').value = ''; checked[f.id] = true; paintFriends();
});
$('friendList').addEventListener('click', function (e) {
  var r = e.target.closest('.fr-row'); if (!r) return;
  checked[r.dataset.id] = !checked[r.dataset.id]; paintFriends();
});
$('sendBtn').addEventListener('click', doSend);
$('confirmNo').addEventListener('click', closeConfirm);
$('confirmYes').addEventListener('click', function () {
  var fn = confirmYes; closeConfirm(); if (fn) fn();
});
