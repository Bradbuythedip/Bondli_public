# The frog with the coffee

Every line here is checked against what the code does; where they disagree, the code wins.

## Launch #37

He was on the couch with a coffee, watching the feed the way you
watch weather. Launch #37 of the day came up: the same picture as #36, the ticker with one letter
changed, the same forty people passing it around like a hot potato, each one sure they would not be
holding it when the music stopped. Most of them were. The chart did what those charts do.

Then #38 came up, and the same forty people were back.

He put the cup down. Not in anger; frogs are not built for anger. More the feeling of watching
someone try the same locked door a third time. The problem was not the launches. A person cannot
watch every launch, cannot sit through every first minute, cannot sell without a story about why they
should hold, and cannot forget the ones that ran. So he wrote something that could.

## The bot that never sleeps

Bondli trades new launches in their first minutes, on pump.fun, on PONS on Robinhood Chain and on
Arc. It does not trade the rest of the market: by the time a chart looks obvious it has usually been
out for a while, or it never went in.

You keep the wallet. The bot gets a wallet of its own to trade from, and you can take the key or the
money out at any time. Nothing leaves it except by a trade you asked for or the fee you were told
about; every route that can move money needs your signature, and a test holds that line.

You can try it before you fund it. Paper mode runs the same feed, gates, sizing and exits with
pretend money: nothing is bought or sold and no fee is charged.

The fee is 5% of each profitable trade, taken from the profit. Losing trades cost nothing. Hold one
$BNDLI in the wallet you sign in with and the fee is 0%.

## The commandments

`docs/AXIOMS.md` is the engineering version. This is the one on the fridge; each is held by a test.

1. Money leaves only by a trade you asked for or a fee you were told about.
2. Never hold what you cannot manage: no readable price for 45 seconds, sold on that fact alone.
3. Every number on the screen reconciles with its own parts.
4. A loss is bounded before it happens: the stop rides the position's own price on every tick, a sell
   is never given away at any price, and losing more today means betting less.
5. You can stop everything, always, in one action. Pause freezes entries, never exits.
6. Try it before you fund it.
7. You can see why, in the bot's own words, reason included.
8. Nothing is lost to our own failure: a crash reconciles from the ledger and the chain first.
9. A call is a fill, never an opinion.
10. A new chain has to earn its way in on trades before it can cost you money: on anything new the
    bot refuses more than it accepts, and every order is rehearsed against the chain before it is sent.
11. On Arc everything is dollars. What you stake, what it is worth, what you made and what we take
    are the same unit, and there is no exchange rate in between to go stale or go missing.

## The bot did it, not me

A call here is the bot's own buy, made with real money, and the transaction is on-chain for anyone to look up. Before a word of it reaches any
channel, the record is written to its own ledger and anchored with `sha256(venue|instrument|tx|ts|mcapUsd|tier|plan)`,
so it cannot be trimmed, edited or back-dated. The close is posted the same way; the losses stay on
the record next to the wins. Paper fills never post, fills below the callout tier never post, one
call per token per hour across every user, and no row names a wallet or a user. A channel that only
shows its winners is the exact thing this exists to not be.

## What $BNDLI is, and is not

$BNDLI is Bondli's own token: name "Bondli", ticker BNDLI, an SPL mint on Solana, to be launched on
pump.fun (until the mint exists the site's ticker links to the X profile; `docs/AXIOMS.md` keeps the
open item). It does one thing. Hold one in the wallet you sign in with and your performance fee is 0%
on every venue you trade. The server reads the balance itself; a failed read never invents a waiver.

It is not a share, not a promise, and not a return. There is no yield. The bot does not buy $BNDLI
for anyone and gives its launch no favours; it is judged like any other launch. Memecoins can go to zero, this one included. Only put in what you can
lose.

No hidden fees. No lockups. Losing trades cost nothing. That is the whole rule.

Roadmap: phase 1, the frog drinks coffee; phase 2, the bot trades first minutes and writes down
everything it did; phase 3, see phase 1. There is no roadmap. There is the ledger.

## Where the frog comes from

The frog on the site, `fren.png`, is our own painting, a frog on a couch with a coffee, and every
colour on the screen is taken off it. He is a homage to a mood, not a copy of a character:

- [Boy's Club](https://en.wikipedia.org/wiki/Boy%27s_Club_(comics)), Matt Furie's comic, where the
  original frog and "feels good man" come from.
- [Matt Furie](https://mattfurie.com), who drew him in 2005.
- [Feels Good Man](https://en.wikipedia.org/wiki/Feels_Good_Man), the 2020 documentary about him and
  the frog.
- [Know Your Meme](https://knowyourmeme.com/memes/pepe-the-frog) and
  [Rare Pepe](https://en.wikipedia.org/wiki/Rare_Pepe): the image boards, the 2015 "do not save"
  years, the trading cards.
- [pepe.vip](https://pepe.vip), the 2023 memecoin whose deadpan site and honest disclaimer set the
  form every frog coin since has borrowed.

Bondli and $BNDLI have no association with Matt Furie or with Pepe the Frog. We are paying homage to
a frog we grew up with online; nothing of his is reproduced here.

The dogs are tired. The frog has had coffee.
