// Poker for sats: libre-poker/play's heads-up limit table (its engine and the citizen's strategy, pinned) over a
// Web Ledgers teller (solidpayorg/teller, pinned). The rules of the money are lib/sats.mjs; this file is wiring:
// the libraries, the ledger from the relays, sign-in, the bank panel, the hand loop forked from play/cash.html.
// The link carries the ledger and the bot's key in the fragment: #ledger=<hash>&bot=<hex>. The fragment never leaves
// the browser (not sent to the server, not in a referrer); it is read once, kept for this tab, and cleared from the bar.
import * as S from './lib/sats.mjs';
const SCHEMA = 'https://cdn.jsdelivr.net/gh/bitcoin-desktop/schema@b8cbf6337c7450fe14ddc5bce00c7280059aab5d';
const SPEC = 'https://cdn.jsdelivr.net/gh/sidestr/spec@e8deb63161c7459ed39c01d2ca9fda3d860b65b6/siding/lib';
const TELLER = 'https://cdn.jsdelivr.net/gh/solidpayorg/teller@7c00ceac4dc37e0526eccd5ae62e1680ac88ec2a/lib/teller.mjs';
const PLAY = 'https://cdn.jsdelivr.net/gh/libre-poker/play@3f226bb297293cebba6e201cdcc493f4634eec95';
const STRATEGY = 'https://librepoker.org/play/strategy-hulimit.json?v=18'; // 27 MB, too big for the CDN; the same file the main table plays
const REEF = 'https://bitcoin-blake.github.io/reef/';
const RELAYS = ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nostr.oxtr.dev'];
const $ = (s) => document.querySelector(s);
const LS = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }, del: (k) => { try { localStorage.removeItem(k); } catch {} } };
const SS = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} } };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Number(n).toLocaleString('en-US');
const short = (s) => (s ? String(s).slice(0, 14) + '…' + String(s).slice(-6) : '');
const caption = (t) => { $('#caption').innerHTML = t; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the link: read once, kept for this tab, cleared from the address bar
{ const lk = S.parseLink(location.hash, location.search); if (lk.ledger) SS.set('sats:ledger', lk.ledger); if (lk.bot) SS.set('sats:bot', lk.bot); if (location.hash) history.replaceState(null, '', location.pathname + location.search); }
const LEDGER_HASH = SS.get('sats:ledger'), BOT_KEY = SS.get('sats:bot');
window.addEventListener('hashchange', () => location.reload()); // a link opened over this page: start again from its fragment

// ---- the libraries
caption('loading the libraries…');
// the CDN's first answer for a commit it has not cached can fail while it fetches; one retry covers that
const libs = () => Promise.all([
  import(`${SCHEMA}/codec/hash.js`), import(`${SCHEMA}/codec/secp256k1.js`), import(`${SCHEMA}/codec/nostr.js`), import(`${SPEC}/schnorr.mjs`), import(`${SPEC}/keys.mjs`), import(`${SPEC}/address.mjs`), import(`${SPEC}/relay.mjs`), import(TELLER), import(`${PLAY}/engine/poker.js`), import(`${PLAY}/engine/ladder.js`), import(`${PLAY}/engine/river-solver.js`),
]);
const [hash, secp, { verifyNostrEvent }, { makeSigner }, { makeKeys }, address, relay, T, P, { ladderDecide, setEquityEdges }, { riverMix }] = await libs().catch(() => sleep(1500).then(libs))
  .catch((e) => { caption(`the libraries could not be loaded from the CDN (${esc(e.message)}); nothing works without them, try again later`); throw e; });
const { newHand, legal, act, bestFive, handName, rankOf, suitOf, RANKS, rngFromSeed } = P;
const signer = makeSigner({ hash, secp }), keys = makeKeys({ hash, secp }), events = relay.makeEvents({ signer, hash });
const deps = { hash, secp, keys, address, signer, events };

// ---- the ledger, from the relays: the operator's own signed copy, the newest
function fetchLedger(hashHex, { timeout = 7000 } = {}) {
  return new Promise((resolve) => {
    let best = null, open = RELAYS.length; const sockets = []; let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(t); for (const w of sockets) { try { w.close(); } catch {} } resolve(best); };
    const t = setTimeout(finish, timeout);
    for (const url of RELAYS) {
      let ws; try { ws = new WebSocket(url); } catch { if (--open <= 0) finish(); continue; } sockets.push(ws);
      ws.onopen = () => ws.send(JSON.stringify(['REQ', 'ledger', { kinds: [T.LEDGER_KIND], '#d': [hashHex], limit: 5 }]));
      ws.onmessage = (m) => { let msg; try { msg = JSON.parse(m.data); } catch { return; }
        if (msg[0] === 'EVENT' && msg[2]?.kind === T.LEDGER_KIND) { const ev = msg[2]; let ok = false; try { ok = verifyNostrEvent(ev); } catch {} if (!ok) return; let doc; try { doc = JSON.parse(ev.content); } catch { return; }
          try { T.checkLedger(deps, doc); } catch { return; } if (doc.hash !== hashHex || T.xOf(doc.genesis.operator) !== ev.pubkey) return;
          if (!best || ev.created_at > best.event.created_at) best = { ledger: doc, event: ev }; }
        if (msg[0] === 'EOSE' || msg[0] === 'CLOSED') { try { ws.close(); } catch {} if (--open <= 0) finish(); } };
      ws.onerror = () => {}; ws.onclose = () => { if (--open <= 0) finish(); };
    }
  });
}
let published = null, ledger = null, pending = []; // the operator's copy; the local copy with the hands since; those hands
const pendingKey = () => 'sats:pending:' + LEDGER_HASH;
try { pending = JSON.parse(LS.get(pendingKey()) || '[]'); } catch { pending = []; }
const savePending = () => LS.set(pendingKey(), JSON.stringify(pending));
function reconcile() { if (!published) return; const r = S.reconcile(T, published, pending); ledger = r.ledger; pending = r.pending; savePending(); drawBalances(); drawAccount(); }
async function refreshLedger() {
  if (!LEDGER_HASH) return;
  const found = await fetchLedger(LEDGER_HASH);
  if (found) { if (!published || found.event.created_at >= published.updated_at) { published = { ...found.ledger, updated_at: found.event.created_at }; reconcile(); } }
  else if (!published) $('#linfo').textContent = 'the ledger was not found on the relays; nothing can be played until it is';
}

// ---- accounts: the hero signs in (an extension or a key kept here); the bot's key came with the link
let account = null; // { did, sign(unsigned) → signed event }
const botPoint = BOT_KEY ? keys.publicKey(BOT_KEY) : null, BOT_DID = botPoint ? keys.did(botPoint) : null;
async function signIn(key) {
  if (key) { if (!/^[0-9a-f]{64}$/i.test(key)) return siStatus('a key is 64 hex characters'); key = key.toLowerCase(); const point = keys.publicKey(key); account = { did: keys.did(point), sign: async (u) => events.signEvent(key, u) }; LS.set('sats:key', key); }
  else if (window.nostr) { try { const x = (await window.nostr.getPublicKey()).toLowerCase(); account = { did: 'did:nostr:' + x, sign: async (u) => window.nostr.signEvent({ ...u, created_at: Math.floor(Date.now() / 1000) }) }; LS.set('sats:nip07', '1'); } catch (e) { return siStatus(`the extension did not sign in: ${esc(e.message)}`); } }
  else return siStatus('no Nostr extension found in this browser: make or paste a key instead');
  drawAccount(); drawBalances();
}
const siStatus = (t) => { $('#si-status').innerHTML = t; };
function drawAccount() {
  const on = !!account; $('#acct').hidden = !on; $('#signin').hidden = on;
  $('#linfo').innerHTML = ledger ? `ledger <b>${esc(ledger.name)}</b> · ${esc(short(ledger.hash))} · operator ${esc(short(ledger.genesis.operator))} · ${ledger.entries.length} account(s), ${fmt(T.total(ledger))} sats on the book` + (published.updated_at ? ` · published ${new Date(published.updated_at * 1000).toLocaleString()}` : '') + (BOT_DID ? `<br>bot ${esc(short(BOT_DID))}` : '<br>⚠ no bot key in the link: nothing to play against') : LEDGER_HASH ? 'ledger…' : '⚠ no ledger in the link (#ledger=…&bot=…)';
  if (!on) return;
  $('#adid').textContent = account.did;
  if (!ledger) { $('#abal').textContent = '…'; $('#aaddr').textContent = '…'; return; }
  $('#abal').textContent = fmt(T.balance(ledger, account.did)) + ' sats';
  const mine = pending.filter((p) => p.from === account.did || p.to === account.did).length;
  $('#apending').textContent = mine ? `(${mine} hand(s) awaiting the operator's scan)` : '';
  const d = T.depositAddress(deps, { operatorPoint: ledger.genesis.operator, ledgerHash: ledger.hash, account: account.did });
  $('#aaddr').textContent = d.address;
  $('#apay').href = REEF + '?pay=' + encodeURIComponent(`bitcoin:${d.address}?label=${encodeURIComponent(ledger.name)}`);
}
function drawBalances() {
  if (!ledger) { $('#balances').textContent = 'ledger…'; return; }
  const me = account ? fmt(T.balance(ledger, account.did)) : '—', bot = BOT_DID ? fmt(T.balance(ledger, BOT_DID)) : '—';
  $('#balances').innerHTML = `you <b style="color:var(--gold)">${me}</b> · bot <b style="color:var(--gold)">${bot}</b> sats`;
}
async function publishRequest(sign, req) {
  const ev = await sign({ kind: T.REQUEST_KIND, tags: T.requestTags({ ledgerHash: ledger.hash, ...req }), content: '' });
  const res = await relay.publish({ relays: RELAYS, event: ev }); const n = Object.values(res).filter((r) => r === 'ok').length;
  if (!n) throw new Error('no relay accepted the request: ' + JSON.stringify(res));
  return { ev, n };
}
$('#b-nip07').addEventListener('click', () => signIn(null));
$('#b-keyuse').addEventListener('click', () => signIn($('#keyin').value.trim()));
$('#b-keynew').addEventListener('click', () => { const k = signer.randomKey(); $('#keyin').value = k; signIn(k); siStatus('a new key was made and kept in this browser; back it up, it is the account'); });
$('#a-signout').addEventListener('click', (e) => { e.preventDefault(); account = null; LS.del('sats:key'); LS.del('sats:nip07'); drawAccount(); drawBalances(); });
$('#aaddr').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#aaddr').textContent); bpStatus('deposit address copied'); } catch { bpStatus('the browser did not allow copying: select the address and copy it'); } });
$('#a-join').addEventListener('click', async (e) => { e.preventDefault(); if (!ledger || !account) return; try { const { n } = await publishRequest(account.sign, { op: 'join' }); bpStatus(`✅ join request published to ${n} relay(s); the operator watches your deposit address from its next scan`); } catch (err) { bpStatus('⚠ ' + esc(err.message)); } });

// ---- withdraw: a signed request; the operator pays it out
const bpStatus = (t) => { $('#bp-status').innerHTML = t; };
const bankPanel = $('#bankpanel');
const disarm = () => { const g = $('#bp-go'); if (g.dataset.armed) { delete g.dataset.armed; g.textContent = 'WITHDRAW'; } };
for (const id of ['#bp-addr', '#bp-amt']) $(id).addEventListener('input', disarm);
$('#b-bank').addEventListener('click', () => { bankPanel.classList.toggle('open'); audio(); disarm(); });
$('#bp-go').addEventListener('click', async () => {
  if (!ledger || !account) return bpStatus('⚠ sign in first; withdrawals are signed with your key');
  const to = $('#bp-addr').value.trim(); const amount = Math.trunc(Number($('#bp-amt').value));
  if (!address.decodeAddress(to)) return bpStatus('⚠ that is not a valid address');
  if (!(amount >= T.MIN_PAY)) return bpStatus(`⚠ a withdrawal is at least ${T.MIN_PAY} sats`);
  if (amount > T.balance(ledger, account.did)) return bpStatus('⚠ more than your balance');
  if (!$('#bp-go').dataset.armed) { $('#bp-go').dataset.armed = '1'; $('#bp-go').textContent = `CONFIRM: withdraw ${fmt(amount)} sats?`; bpStatus(`this asks the operator to send <b>${fmt(amount)} sats</b> (less the miner fee) to<br>${esc(to)}<br>click again to confirm, or edit to cancel`); return; }
  disarm(); $('#bp-go').disabled = true;
  try { const { ev, n } = await publishRequest(account.sign, { op: 'withdraw', amount, to }); bpStatus(`✅ withdrawal request ${esc(ev.id.slice(0, 16))}… published to ${n} relay(s); the operator pays it out by hand and the ledger then shows the debit`); }
  catch (err) { bpStatus('⚠ ' + esc(err.message)); }
  $('#bp-go').disabled = false;
});

// ---- the table (forked from play/cash.html)
const GLYPH = { c: '♣', d: '♦', h: '♥', s: '♠' };
const ascii = (c) => RANKS[rankOf(c)] + 'cdhs'[suitOf(c)];
const isRed = (a) => a[1] === 'd' || a[1] === 'h';
function cardEl(a) { const d = document.createElement('div'); d.className = 'card flipin s-' + a[1] + (isRed(a) ? ' red' : ''); d.innerHTML = `<div class="cr">${a[0] === 'T' ? '10' : a[0]}<b>${GLYPH[a[1]]}</b></div><div class="cp">${GLYPH[a[1]]}</div>`; return d; }
function backEl() { const d = document.createElement('div'); d.className = 'card back'; return d; }
const DENOMS = [[500, 'd500'], [100, 'd100'], [25, 'd25'], [5, 'd5']];
function chipStackInto(el, amount) {
  el.innerHTML = ''; let rest = Math.max(0, Math.round(amount / 5) * 5);
  for (const [v, cls] of DENOMS) { let n = Math.floor(rest / v); rest -= n * v; while (n > 0) { const col = document.createElement('span'); col.className = 'col ' + cls; for (let k = 0; k < Math.min(4, n); k++) col.appendChild(document.createElement('i')); el.appendChild(col); n -= Math.min(4, n); } }
}
let ac = null, master = null, soundOn = LS.get('lp.sound') !== '0';
function audio() { if (ac) return; try { ac = new (window.AudioContext || window.webkitAudioContext)(); master = ac.createGain(); master.gain.value = .5; master.connect(ac.destination); } catch { /* silent */ } }
const ready = () => soundOn && ac && ac.state === 'running' && !document.hidden;
function blip(freq, dur = .06, gain = .05, type = 'triangle') {
  if (!ready()) return;
  try { const o = ac.createOscillator(), g = ac.createGain(); o.type = type; o.frequency.value = freq; g.gain.setValueAtTime(.0001, ac.currentTime); g.gain.linearRampToValueAtTime(gain * 2.2, ac.currentTime + .003); g.gain.exponentialRampToValueAtTime(.0001, ac.currentTime + dur); o.connect(g); g.connect(master); o.start(); o.stop(ac.currentTime + dur); } catch { /* shrug */ }
}
const sq = (n, gap, dur, gain) => n.forEach((f, i) => setTimeout(() => blip(f, dur, gain, 'sine'), i * gap));
const sCard = () => blip(1180, .04, .02); const sChip = () => blip(720, .05, .03);
const sPos = (btn) => btn ? sq([1320, 1760], 55, .05, .032) : blip(196, .12, .045, 'sine');
const sLedger = () => sq([523, 659, 784], 80, .12, .04);
document.addEventListener('pointerdown', audio); document.addEventListener('keydown', audio);
const sha256hex = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join('');

const seats = [0, 1].map((i) => ({ root: $('#seat-' + i), nm: $(`#seat-${i} .nm`), pos: $(`#seat-${i} .pos`), stk: $(`#seat-${i} .stk`), bb: $(`#seat-${i} .bbline`), said: $(`#seat-${i} .said`), cards: $('#cards-' + i) }));
const HERO = 0, BOT = 1;
let h = null, handNo = 0, shownBoard = 0, commit8 = '';
function dealCards() { seats[HERO].cards.innerHTML = ''; for (const c of h.seats[HERO].hole) seats[HERO].cards.appendChild(cardEl(ascii(c))); seats[BOT].cards.innerHTML = ''; for (const c of h.seats[BOT].hole) seats[BOT].cards.appendChild(backEl()); }
function revealBot() { seats[BOT].cards.innerHTML = ''; for (const c of h.seats[BOT].hole) seats[BOT].cards.appendChild(cardEl(ascii(c))); }
function syncBoard() { const b = $('#board'); while (b.children.length < h.board.length && b.children.length < shownBoard) b.appendChild(cardEl(ascii(h.board[b.children.length]))); }
function render() {
  syncBoard();
  for (const i of [0, 1]) {
    const d = seats[i];
    d.nm.textContent = i === HERO ? 'You' : 'Bot ' + (BOT_DID ? BOT_DID.slice(10, 18) : '');
    d.stk.textContent = h.seats[i].stack.toLocaleString(); d.bb.textContent = (h.seats[i].stack / h.bb).toFixed(0) + ' BB';
    d.pos.textContent = h.button === i ? 'SB' : 'BB';
    d.root.classList.toggle('glow', h.phase === 'act' && h.toAct === i);
    const bet = $('#bet-' + i); const amt = h.seats[i].streetCommit;
    bet.classList.toggle('show', amt > 0 && h.phase === 'act');
    if (amt > 0) { chipStackInto(bet.querySelector('.cstack'), amt); bet.querySelector('.amt').textContent = amt; }
  }
  const carried = h.seats[0].handCommit + h.seats[1].handCommit - h.seats[0].streetCommit - h.seats[1].streetCommit;
  $('#pot').textContent = carried > 0 ? 'Pot ' + carried.toLocaleString() : '';
  $('#table').classList.toggle('boardout', shownBoard > 0);
  document.querySelectorAll('.dbtn').forEach((e) => e.remove());
  const db = document.createElement('span'); db.className = 'dbtn'; db.textContent = 'D'; seats[h.button].root.querySelector('.who').appendChild(db);
}
let keyTargets = null;
function heroTurn(L) {
  return new Promise((resolve) => {
    const bar = $('#actions'); bar.innerHTML = ''; bar.classList.toggle('pos-btn', h.button === HERO); bar.classList.toggle('pos-bb', h.button !== HERO);
    const mk = (id, label, a) => { const b = document.createElement('button'); b.id = id; b.textContent = label; b.addEventListener('click', () => { bar.innerHTML = ''; keyTargets = null; resolve(a); }); bar.appendChild(b); return b; };
    mk('b-fold', 'FOLD', { seat: HERO, action: 'fold' });
    mk('b-call', L.callAmount === 0 ? 'CHECK' : 'CALL ' + L.callAmount, { seat: HERO, action: L.callAmount === 0 ? 'check' : 'call' });
    if (L.actions.includes('bet') || L.actions.includes('raise')) mk('b-raise', (L.actions.includes('bet') ? 'BET ' : 'RAISE TO ') + L.minRaiseTo, { seat: HERO, action: L.actions.includes('bet') ? 'bet' : 'raise', amount: L.minRaiseTo });
    keyTargets = ['b-fold', 'b-call', 'b-raise'];
  });
}
document.addEventListener('keydown', (e) => {
  if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  if (!keyTargets) { if ((e.key === '1' || e.key === 'Enter') && $('#b-next')) $('#b-next').click(); return; }
  const idx = { 1: 0, f: 0, 2: 1, c: 1, 3: 2, r: 2 }[e.key];
  if (idx != null) document.getElementById(keyTargets[idx])?.click();
});

// ---- the strategy (the citizen's brain from the main table); without it the bot calls
let T_ = null;
async function loadStrategy() {
  caption('fetching the bot\'s strategy (27 MB, once)…');
  try { T_ = await (await fetch(STRATEGY)).json(); if (T_.edges) setEquityEdges(T_.edges); caption(''); }
  catch { T_ = null; caption('⚠ the strategy could not be fetched; the bot checks and calls'); }
}
function botAction(L, cache) {
  if (!T_) return { seat: BOT, action: L.callAmount > 0 ? 'call' : 'check' };
  if (h.street === 3) { const mix = riverMix(h, BOT, T_.table, cache); if (mix) { let x = Math.random(), pick = 0; for (let k = 0; k < mix.probs.length; k++) { x -= mix.probs[k]; if (x <= 0) { pick = k; break; } } const ch = mix.acts[Math.min(pick, mix.acts.length - 1)];
    if (ch === 'f' && L.callAmount > 0) return { seat: BOT, action: 'fold' }; if (ch === 'b' && (L.actions.includes('bet') || L.actions.includes('raise'))) return { seat: BOT, action: L.actions.includes('bet') ? 'bet' : 'raise', amount: L.minRaiseTo }; return { seat: BOT, action: L.callAmount > 0 ? 'call' : 'check' }; } }
  return ladderDecide(h, BOT, L, T_.table, 0, Math.random);
}

// ---- settlement: the loser signs a transfer to the winner; applied locally at once, by the operator on its next scan
async function settle(st) {
  const s = S.settlement(h, { hero: account.did, bot: BOT_DID }, HERO, st);
  if (!s) { caption('split: nothing moves'); return; }
  const sign = s.from === account.did ? account.sign : (u) => events.signEvent(BOT_KEY, u);
  caption(s.from === account.did ? '⚡ signing the transfer to the bot…' : '⚡ the bot signs its transfer to you…');
  try {
    const { ev, n } = await publishRequest(sign, { op: 'transfer', amount: s.amount, to: s.to });
    const r = T.parseRequest(ev, { verify: verifyNostrEvent, ledgerHash: ledger.hash });
    pending.push({ id: r.id, from: r.account, to: r.to, amount: r.amount, created_at: r.created_at }); reconcile(); sLedger();
    caption(`⚡ ${s.to === account.did ? '+' : '−'}${fmt(s.amount)} sats signed to ${n} relay(s) · you ${fmt(T.balance(ledger, account.did))} · bot ${fmt(T.balance(ledger, BOT_DID))}`);
  } catch (e) { caption('⚠ the transfer was not published: ' + esc(e.message) + ' — this hand is not on the ledger'); }
}

async function waitToSit() {
  for (;;) {
    if (!ledger) { caption(LEDGER_HASH ? 'waiting for the ledger from the relays…' : '⚠ open this page from a link with #ledger=…&bot=…'); await sleep(2000); continue; }
    if (!BOT_DID) { caption('⚠ no bot key in the link: nothing to play against'); await sleep(5000); continue; }
    if (!account) { caption('sign in at 🏦 bank to play: a Nostr extension or a key kept in this browser'); await sleep(1000); continue; }
    const can = S.canSit(T, ledger, account.did, BOT_DID, stakes);
    if (!can.hero) { caption(`you need ${fmt(stakes.buyin)} sats on the ledger to sit at ${stakes.label} (you have ${fmt(T.balance(ledger, account.did))}): deposit at 🏦 bank, then Join, and the operator credits it — or choose smaller stakes at the top`); await sleep(3000); continue; }
    if (!can.bot) { caption(`the bot is out of sats (${fmt(T.balance(ledger, BOT_DID))}); its operator must top it up`); await sleep(5000); continue; }
    return;
  }
}
async function playHand() {
  await waitToSit();
  handNo++;
  const seed = await sha256hex(`sats|${Date.now()}|${handNo}|${Math.random()}`); commit8 = (await sha256hex(seed)).slice(0, 8);
  const st = stakes; h = newHand({ seats: [{ name: 'You', stack: st.buyin }, { name: 'Bot', stack: st.buyin }], button: handNo % 2, sb: st.sb, bb: st.bb, seedHex: seed, limit: true });
  const cache = {}; shownBoard = 0;
  $('#verdict').textContent = ''; $('#board').innerHTML = '';
  $('#tmeta').textContent = `limit hold'em · ${st.label} sats · hand #${handNo} · ${commit8}`;
  dealCards(); render(); sCard(); sPos(h.button === HERO); caption('');
  let lastStreet = 0, guard = 0;
  while (h.phase === 'act' && guard++ < 200) {
    if (h.street !== lastStreet) { lastStreet = h.street; shownBoard = [0, 3, 4, 5][h.street]; render(); sCard(); await sleep(200); }
    const L = legal(h);
    if (L.seat === HERO) { render(); const a = await heroTurn(L); act(h, a); if (a.action !== 'fold') sChip(); seats[HERO].said.textContent = a.action + (a.amount ? ' ' + a.amount : ''); }
    else { await sleep(250 + Math.random() * 350); const a = botAction(L, cache); act(h, a); if (a.action !== 'fold') sChip(); seats[BOT].said.textContent = a.action + (a.amount ? ' ' + a.amount : ''); }
    render();
  }
  const r = h.result; shownBoard = h.board.length >= 3 ? h.board.length : shownBoard;
  if (r.showdown) revealBot();
  render();
  const winSeats = new Set(r.winners.map((x) => x.seat));
  if (r.showdown) {
    const winCards = new Set(); for (const w of winSeats) for (const c of bestFive([...h.seats[w].hole, ...h.board])) winCards.add(c);
    [...$('#board').children].forEach((el, bi) => el.classList.add(winCards.has(h.board[bi]) ? 'win' : 'dead'));
    for (const i of [0, 1]) { const won = winSeats.has(i); [...seats[i].cards.children].forEach((el, ci) => el.classList.add(won && winCards.has(h.seats[i].hole[ci]) ? 'win' : 'dead')); }
    const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
    $('#verdict').innerHTML = Object.entries(r.evals ?? {}).map(([i, e]) => `<span class="vtag ${winSeats.has(+i) ? 'vw' : 'vl'}">${+i === HERO ? 'You' : 'Bot'}: ${cap(handName(e))}</span>`).join('');
  }
  const delta = h.seats[HERO].stack - st.buyin;
  $('#pot').classList.add('winline'); $('#pot').textContent = delta > 0 ? `You win ${delta} sats` : delta < 0 ? `Bot wins ${-delta} sats` : 'Split';
  seats.forEach((s2) => { s2.said.textContent = ''; });
  await settle(st);
  await new Promise((resolve) => { const bar = $('#actions'); const bn = document.createElement('button'); bn.id = 'b-next'; bn.textContent = 'NEXT HAND'; bn.addEventListener('click', resolve); bar.appendChild(bn); setTimeout(resolve, 4000); });
  $('#actions').innerHTML = ''; $('#pot').classList.remove('winline');
}

// ---- the stakes: chosen at the top, remembered here, applied from the next hand
let stakes = S.stakesOf(LS.get('sats:bb'));
{ const sel = $('#stakes'); for (const st of S.STAKES) { const o = document.createElement('option'); o.value = st.bb; o.textContent = `${st.label} sats`; sel.appendChild(o); } sel.value = stakes.bb;
  sel.addEventListener('change', () => { stakes = S.stakesOf(sel.value); sel.value = stakes.bb; LS.set('sats:bb', stakes.bb); caption(`stakes ${stakes.label} from the next hand (buy-in ${fmt(stakes.buyin)} sats)`); }); }

// ---- settings, as on the main table
let fourColor = LS.get('lp.fourc') !== '0';
const drawFourc = () => { document.body.classList.toggle('fourc', fourColor); $('#b-fourc').classList.toggle('on', fourColor); };
$('#b-fourc').addEventListener('click', () => { fourColor = !fourColor; LS.set('lp.fourc', fourColor ? '1' : '0'); drawFourc(); audio(); }); drawFourc();
const sndBtn = $('#b-sound'); const drawSnd = () => { sndBtn.textContent = soundOn ? '🔊' : '🔇'; };
sndBtn.addEventListener('click', () => { soundOn = !soundOn; LS.set('lp.sound', soundOn ? '1' : '0'); drawSnd(); audio(); }); drawSnd();

// ---- start
{ const k = LS.get('sats:key'); if (k) await signIn(k); else if (LS.get('sats:nip07') && window.nostr) await signIn(null); }
drawAccount(); drawBalances();
await refreshLedger(); setInterval(() => refreshLedger().catch(() => {}), 45000);
await loadStrategy();
(async () => { for (;;) await playHand(); })();
