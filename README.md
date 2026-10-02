# Libre Poker · sats

Heads-up limit hold'em for test sats: the main table's engine and strategy over a [Web Ledgers teller](https://github.com/solidpayorg/teller). Every finished hand is one signed transfer from the loser to the winner on the ledger; deposits come from any wallet, withdrawals go to your own. On **txbt4** (the BLAKE2b testnet4): test coins, no value, no rake.

A playground. Nothing here touches `play/`, the croupier, the bots or the schema; it imports the engine and the teller pinned by commit and adds no protocol of its own.

Live: https://librepoker.org/sats/ — a table needs a link with its ledger and its bot: `#ledger=<hash>&bot=<hex>`.

## How it works

- **The ledger** is a teller ledger: the operator holds the deposits and publishes the balances as a Nostr event; everyone reads it. Each account's deposit address is derived from the operator's key and the account's did (the teller's rule, `webledgers/deposit`), so the page shows yours without asking anyone.
- **A hand** is played at the stakes chosen at the top (1/2 to 100/200 sats, the buy-in 100 big blinds on both sides; 10/20 by default), limit hold'em exactly as on the main table. Everything in a limit hand is a unit of the big blind, so the bot plays the same game at every size. When it ends, the loser signs a teller `transfer` of the difference to the winner (a kind-3700 request) and publishes it to the relays. The page applies it to its copy the moment it is signed (milliseconds) and deals the next hand; publishing runs apart, retried until a relay has taken it (⟳ at the top counts hands still to send), so a closed tab loses nothing. The teller's automatic operator (`bin/operator.mjs` in solidpayorg/teller) applies the transfers every minute and republishes the ledger; the page's pending hands are checked off as the ledger catches up.
- **The bot** is the main table's citizen (its strategy, 27 MB, fetched from librepoker.org once). It is an account like any other: its key comes in the link's fragment, so the page can sign its transfers when it loses. Its balance is its bankroll; when it runs out, nobody can play until its operator tops it up.
- **Deposit and withdraw** are the teller's: pay the address (the page links to [Reef](https://bitcoin-blake.github.io/reef/) with it filled in), Join so the operator watches it, and the credit appears after the ledger's confirmations; a withdrawal is a signed request the operator pays out within a minute, under its caps (above them, a hand pays it from the teller page); the bank panel lists each one you asked for with its state, waiting or paid with the transaction.

What it is, plainly: a demo of the rails. The bot's key sits in the link and in whoever's tab opens it, so anyone with the link can play the bot's money and withdraw it; a two-party game where neither side holds the other's key is a later step (the schema's SETTLEMENT.md is the shape). The fragment is read once, kept for the tab and cleared from the address bar; it is never sent to the server or in a referrer.

## Files

- `lib/sats.mjs`: the rules, pure: what a finished hand owes, whether a seat covers a buy-in, the local copy reconciled with the published ledger, the link parsed.
- `sats.js`, `index.html`: the page. The skin is `play/cash.html`'s, forked verbatim. Libraries pinned by commit from the CDN: the engine (bitcoin-desktop/schema), the sidestr library (keys, signing, addresses, relays), the teller (solidpayorg/teller), the poker engine (libre-poker/play). Ledger and requests on public Nostr relays.
- `test/sats-test.mjs`: `npm test` with `SCHEMA`, `SIDESTR_LIB`, `TELLER`, `PLAY` pointing at checkouts (defaults under `~`): 11 checks against the real engine and the real teller library.

## Running a table

Make a ledger on the [teller page](https://solidpayorg.github.io/teller/) as its operator, make a key for the bot, deposit to the bot's address, Join it and scan. Hand out `https://librepoker.org/sats/#ledger=<hash>&bot=<the bot's key>`. Run the teller's operator (`bin/operator.mjs`) for the ledger so hands are applied and withdrawals paid every minute, or scan by hand on the teller page.

GitHub Pages serves `gh-pages` as it is. AGPL-3.0-or-later.
