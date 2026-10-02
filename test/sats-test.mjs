// lib/sats.mjs against the real engine and the real teller library: a hand's settlement is a transfer the loser
// signs, a split is nothing, the local copy reconciles with what the operator publishes, links parse.
//   SCHEMA=<bitcoin-desktop/schema> SIDESTR_LIB=<siding/lib> TELLER=<solidpayorg/teller> PLAY=<libre-poker/play> node test/sats-test.mjs
import os from 'node:os';
const H = (p) => p.replace(/^~/, os.homedir());
const SCHEMA = H(process.env.SCHEMA ?? '~/bitcoin-desktop/schema'), LIB = H(process.env.SIDESTR_LIB ?? '~/remote/github.com/sidestr/spec/siding/lib');
const TELLER = H(process.env.TELLER ?? '~/remote/github.com/solidpayorg/teller'), PLAY = H(process.env.PLAY ?? '~/remote/github.com/libre-poker/play');
const [hash, secp, { makeSigner }, { makeKeys }, { makeEvents }, { verifyNostrEvent }, T, P, S] = await Promise.all([
  import(`${SCHEMA}/codec/hash.js`), import(`${SCHEMA}/codec/secp256k1.js`), import(`${LIB}/schnorr.mjs`), import(`${LIB}/keys.mjs`), import(`${LIB}/relay.mjs`), import(`${SCHEMA}/codec/nostr.js`), import(`${TELLER}/lib/teller.mjs`), import(`${PLAY}/engine/poker.js`), import('../lib/sats.mjs')]);
const signer = makeSigner({ hash, secp }), keys = makeKeys({ hash, secp }), events = makeEvents({ signer, hash }); const deps = { hash, keys };
let ok = 0, bad = 0;
const t = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`); cond ? ok++ : bad++; };
const throws = (f, re) => { try { f(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

const opKey = signer.randomKey(), heroKey = signer.randomKey(), botKey = signer.randomKey();
const did = (k) => keys.did(keys.publicKey(k)); const op = did(opKey), hero = did(heroKey), bot = did(botKey);
const L = T.newLedger(deps, { operator: op, name: 'Sats test', created: 1790900000 });
T.credit(L, { account: hero, txid: 'aa'.repeat(32), vout: 0, value: 5000 }, 1); T.credit(L, { account: bot, txid: 'bb'.repeat(32), vout: 0, value: 100000 }, 1);
t('a seat needs a buy-in on the ledger', S.canSit(T, L, hero, bot).hero && S.canSit(T, L, hero, bot).bot && !S.canSit(T, L, 'did:nostr:' + 'cc'.repeat(32), bot).hero);

// a hand folded preflop: the small blind folds, the big blind wins the small blind
const seed = 'ab'.repeat(32);
const play = (acts) => { const h = P.newHand({ seats: [{ name: 'You', stack: S.BUYIN }, { name: 'Bot', stack: S.BUYIN }], button: 0, sb: S.SB, bb: S.BB, seedHex: seed, limit: true }); for (const a of acts) P.act(h, a); return h; };
const h1 = play([{ seat: 0, action: 'fold' }]);
t('a hand still being played has no settlement', throws(() => S.settlement(play([]), { hero, bot }), /not over/));
const s1 = S.settlement(h1, { hero, bot });
t('hero folds the small blind: hero owes the bot 10 sat', s1 && s1.from === hero && s1.to === bot && s1.amount === S.SB, JSON.stringify(s1));
const h2 = play([{ seat: 0, action: 'call' }, { seat: 1, action: 'raise', amount: 40 }, { seat: 0, action: 'fold' }]);
const s2 = S.settlement(h2, { hero, bot });
t('hero calls then folds to a raise: hero owes 20 sat', s2 && s2.from === hero && s2.to === bot && s2.amount === S.BB, JSON.stringify(s2));
// the engine's hand result decides the winner; a bot fold pays the hero
const h3 = play([{ seat: 0, action: 'call' }, { seat: 1, action: 'raise', amount: 40 }, { seat: 0, action: 'raise', amount: 60 }, { seat: 1, action: 'fold' }]);
const s3 = S.settlement(h3, { hero, bot });
t('the bot folds to a three-bet: the bot owes the hero 40 sat', s3 && s3.from === bot && s3.to === hero && s3.amount === 40, JSON.stringify(s3));

// the loser signs the transfer as a teller request; the operator reads it back as from the signer
const ev = T.requestEvent({ events }, heroKey, { ledgerHash: L.hash, op: 'transfer', amount: s1.amount, to: s1.to });
const r = T.parseRequest(ev, { verify: verifyNostrEvent, ledgerHash: L.hash });
t('the transfer is a kind-3700 request signed by the loser, naming the winner and the amount', ev.kind === T.REQUEST_KIND && r.op === 'transfer' && r.account === hero && r.to === bot && r.amount === 10);
const bad1 = T.requestEvent({ events }, botKey, { ledgerHash: L.hash, op: 'transfer', amount: 10, to: bot });
t("a transfer signed by the wrong key is the signer's own money, never the loser's", T.parseRequest(bad1, { verify: verifyNostrEvent, ledgerHash: L.hash }).account === bot);

// the local copy: hands applied at once, reconciled against what the operator publishes
const pending = [{ id: r.id, from: r.account, to: r.to, amount: r.amount, created_at: r.created_at }];
let { ledger: local, pending: p1 } = S.reconcile(T, L, pending);
t('a pending hand is applied to the local copy, the published ledger untouched', T.balance(local, hero) === 4990 && T.balance(local, bot) === 100010 && T.balance(L, hero) === 5000 && p1.length === 1);
T.transfer(L, pending[0], pending[0].created_at); // the operator applies it and publishes
({ ledger: local, pending: p1 } = S.reconcile(T, L, pending));
t('once published, the hand is dropped from pending and not applied twice', T.balance(local, hero) === 4990 && p1.length === 0 && local.applied.includes(r.id));
const big = [{ id: 'ff'.repeat(16), from: hero, to: bot, amount: 999999, created_at: 2 }];
t('a hand that would overdraw the published copy is dropped, never applied', S.reconcile(T, L, big).pending.length === 0 && T.balance(S.reconcile(T, L, big).ledger, hero) === 4990);

// stakes: every amount a unit of the big blind, so a hand at 100/200 owes ten times a hand at 10/20
const hi = S.stakesOf(200);
t('stakes: small blind half the big, buy-in 100 big blinds; an unknown size falls back to 10/20', hi.sb === 100 && hi.buyin === 20000 && hi.label === '100/200' && S.stakesOf('7').bb === 20 && S.STAKES.every((s) => Number.isInteger(s.sb)));
const hb = P.newHand({ seats: [{ name: 'You', stack: hi.buyin }, { name: 'Bot', stack: hi.buyin }], button: 0, sb: hi.sb, bb: hi.bb, seedHex: seed, limit: true }); P.act(hb, { seat: 0, action: 'fold' });
const sb = S.settlement(hb, { hero, bot }, 0, hi);
t('at 100/200 the folded small blind owes 100 sat, and the seat needs 20,000 to sit', sb && sb.amount === 100 && sb.from === hero && !S.canSit(T, L, hero, bot, hi).hero && S.canSit(T, L, hero, bot, hi).bot);

// a hand is applied the moment it is signed; publishing is apart, retried until one relay has it
const q = [{ id: 'q1', from: hero, to: bot, amount: 10, created_at: 3, published: false, event: ev }, { id: 'q2', from: hero, to: bot, amount: 10, created_at: 3, published: true, event: ev }, { id: 'q3', from: hero, to: bot, amount: 10, created_at: 3 }];
t('a pending hand keeps its published flag through reconcile; the unpublished ones are the retry queue', S.unpublished(q).map((p) => p.id).join() === 'q1' && S.reconcile(T, L, q).pending.filter((p) => p.published).length === 1 && S.reconcile(T, L, q).pending.length === 3);

// a withdrawal is waiting until the ledger shows its payout, then paid with the txid
const wid = 'ab'.repeat(16); t('a withdrawal request is waiting until the operator pays it, then paid with its txid', S.withdrawalStatus(L, wid).state === 'waiting' && (T.debit(L, { id: wid, account: bot, amount: 1000, to: 'tb1p…', txid: 'cd'.repeat(32) }, 9).applied, S.withdrawalStatus(L, wid).state === 'paid' && S.withdrawalStatus(L, wid).txid === 'cd'.repeat(32)));

// links
const lk = S.parseLink('#ledger=' + L.hash + '&bot=' + botKey.toUpperCase(), '');
t('the fragment carries the ledger hash and the bot key; a bad value is null', lk.ledger === L.hash && lk.bot === botKey && S.parseLink('#bot=xyz', '?ledger=' + L.hash).bot === null && S.parseLink('', '?ledger=' + L.hash).ledger === L.hash);

console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
