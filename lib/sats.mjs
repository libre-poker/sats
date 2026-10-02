// Poker for sats: the glue between a hand of heads-up limit (libre-poker/play's engine) and a Web Ledgers teller
// (solidpayorg/teller). Pure: no DOM, no network. A hand is played for a fixed buy-in on both sides; when it ends the
// loser signs one teller `transfer` to the winner, which the operator applies on its next scan. This page keeps a
// local copy of the ledger with the hands since the last published copy applied, so balances read right at once.
export const BUYIN = 2000, SB = 10, BB = 20; // limit 10/20, both stacks 2,000 sat for every hand

/** the hash and bot key from the page's fragment, "#ledger=<hash>&bot=<hex>" (the query may carry ledger= too) */
export function parseLink(fragment = '', query = '') {
  const f = new URLSearchParams(String(fragment).replace(/^#/, '')), q = new URLSearchParams(String(query).replace(/^\?/, ''));
  const hex = (s, n) => (s && new RegExp(`^[0-9a-f]{${n}}$`).test(s.toLowerCase()) ? s.toLowerCase() : null);
  return { ledger: hex(f.get('ledger') ?? q.get('ledger'), 64), bot: hex(f.get('bot'), 64) };
}

/** both seats cover a buy-in on the ledger as it stands */
export const canSit = (T, ledger, hero, bot) => ({ hero: T.balance(ledger, hero) >= BUYIN, bot: T.balance(ledger, bot) >= BUYIN });

/** what a finished hand owes: the transfer the loser signs, or null for a split */
export function settlement(h, { hero, bot }, HERO = 0) {
  if (!h || h.phase === 'act' || !h.result) throw new Error('the hand is not over');
  const delta = h.seats[HERO].stack - BUYIN; if (!Number.isInteger(delta)) throw new Error('a stack is not whole satoshis');
  if (Math.abs(delta) > BUYIN) throw new Error('a hand cannot move more than its buy-in');
  if (delta === 0) return null;
  return delta > 0 ? { from: bot, to: hero, amount: delta } : { from: hero, to: bot, amount: -delta };
}

/** a fresh copy of the ledger with the hands the operator has not yet published applied; the ones it has are dropped */
export function reconcile(T, fresh, pending) {
  const led = JSON.parse(JSON.stringify(fresh)); const still = [];
  for (const p of pending) { if (led.applied?.includes(p.id)) continue; try { T.transfer(led, p, p.created_at); still.push(p); } catch { /* overdrawn against the published copy: dropped, the operator will refuse it too */ } }
  return { ledger: led, pending: still };
}
