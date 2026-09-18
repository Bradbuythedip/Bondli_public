# Launch thread for Bondli and $BNDLI

House rules for anything posted from these drafts: every claim below is something the code does
(see `docs/AXIOMS.md` and `docs/LORE.md`); nothing claims a return; nothing names a wallet; every
number is a placeholder until it is copied from the live record. Each English tweet is at most 260
characters. Each Chinese tweet is at most 130 characters, because X weighs a CJK character as two.

## Before posting: numbers that must come from the live record

Never type a P&L, a win rate or a count from memory. Fill each placeholder from the live source named
here, at the time of posting, and re-check it if the post is delayed by more than an hour.

| Placeholder | Meaning | Where it comes from |
|---|---|---|
| `{{MINT}}` | the $BNDLI mint address | the launch banner on bondli.fun once `status` is `live`; the same value as `BNDLI_MINT` on the server |
| `{{CLOSES}}` | live closes in the current record | `/api/callouts` summary (`resolved`) |
| `{{WIN_RATE}}` | share of those closes that were wins | `/api/callouts` summary (`winRate`), rounded down, never up |
| `{{PNL}}`, `{{TICKER}}`, `{{HELD}}` | one real close | one row of `/api/callouts` with a `result`; the share button on the Calls tab writes this text for you |
| `{{TX}}` | its transaction | the same row; the link the Calls tab shows under "the tx is on-chain" |
| tweet 10/ (and 10/ of the Chinese thread) | the one that says $BNDLI is launched on pump.fun | post only once the launch banner on bondli.fun reads `live`; until then the mint does not exist (`docs/AXIOMS.md`) and the tweet is held back, not reworded |

If a placeholder cannot be filled from the record, delete the tweet that needs it. Do not round a
loss into a win, do not pick the best window, and do not quote a paper close anywhere: paper never
posts, and that includes here. A stretch of the record is bad, and it stays in the record. As this
file is written the open list in `docs/AXIOMS.md` shows a 4% win rate over the last 24 live closes on
Robinhood Chain; if it is still bad on launch day, say so in the thread rather than around it.

## The thread (English)

1/
Meet the frog with the coffee.

He watched launch #37 of the day get passed around like a hot potato, everyone sure they would not be the one holding it at the end. Most of them were.

He put the cup down and wrote a bot that never sleeps. This is Bondli. 🧵

2/
Bondli trades new launches in their first minutes, on pump.fun, on PONS on Robinhood Chain, on Arc.

It does not chase what already ran. By the time a chart looks obvious, it has been out for a while, or it never went in.

3/
You keep the wallet.

The bot gets a wallet of its own to trade from. You can pull the key or the money out at any time. Nothing moves without a trade you asked for or a fee you were told about.

Rule one. Enforced in code, held by a test, not by a promise.

4/
Try it before you fund it.

Paper mode runs the same feed, the same gates, the same exits, with pretend money. Nothing is bought or sold. No fee is charged.

Watch it work first. The frog insists.

5/
Every loss is bounded before it happens, not explained after.

The stop rides the position's own price on every tick. A sell never takes less than 85% of the curve's own quote. Lose more today and it bets less, smoothly, until it stops.

6/
Every channel has "calls".

Ours differ in exactly one way: a call is a fill. The bot bought it, with real money, and the transaction is on-chain for anyone to look up.

Not an opinion. A receipt.

7/
Before a call is posted anywhere it is written to a ledger and hashed: sha256(venue|instrument|tx|ts|mcapUsd|tier|plan).

After that it cannot be trimmed, edited or back-dated. The close is posted the same way.

Losses stay on the record.

8/
Paper trades never post. Fills below the tier never post. One call per token per hour, across every user. No row names a wallet or a user.

A channel that only shows its winners is the exact thing this exists to not be.

9/
The fee: 5% of each profitable trade, taken from the profit. Losing trades cost nothing.

No subscription. No lockup. Hold one $BNDLI and it is 0%.

That is the whole fee.

10/
$BNDLI.

Name: Bondli. Ticker: BNDLI. An SPL mint on Solana, launched on pump.fun.

Hold one in the wallet you sign in with and your fee is 0% on every venue you trade.

That is what it does. That is all it does.

11/
What $BNDLI is not: a share, a promise, a return.

The bot does not buy it for anyone. It judges the launch like any other: no favours, no auto-buy.

Memecoins can go to zero, this one included. Only trade what you can lose. The frog says this with love.

12/
Green candles you cannot verify are a bedtime story.

Bondli posts its own fills, hashed before they are posted, losses and all. Paper never counts.

The bot did it, not me. 🐸

https://bondli.fun

## Standalone tweets (English)

A. (fill from one real close; the Calls tab share button writes this exact shape)
{{PNL}}% on ${{TICKER}} in {{HELD}}. The bot did it, not me 🐸
{{TX}}

B.
Fill confirmed. Feels good, man.
It was hashed into the ledger before this was typed. If it goes wrong, that is posted too. https://bondli.fun

C.
Roadmap.
Phase 1: the frog drinks coffee.
Phase 2: the bot trades launches in their first minutes and writes down everything it did.
Phase 3: see phase 1.
There is no roadmap. There is the ledger.

D.
No hidden fees. No lockups. Losing trades cost nothing. Hold one $BNDLI and the fee is 0%.
That is the whole rule. https://bondli.fun

E.
The dogs are tired. The frog has had coffee.
Paper mode first. You keep the wallet. Every call is a real fill, losses included.
https://bondli.fun

## 发布串（简体中文）

Written for crypto Twitter in Chinese, not translated line by line. Same rules: every claim is what
the code does, no returns promised, no wallet named, every number from the live record.

1/
认识一下这只端着咖啡的青蛙。

当天第37个新盘，一群人像传烫手山芋一样接来接去，个个都觉得自己不会是最后一棒。结果大多数都是。

他把杯子放下，写了一个不睡觉的机器人。这就是 Bondli。🧵

2/
Bondli 只打新盘开盘后的头几分钟：pump.fun、Robinhood Chain 上的 PONS、还有 Arc。

不追已经飞了的土狗，也不劝你冲。等K线看着“很明显”了，它要么早走了，要么根本没进。

3/
钱包在你手里。

机器人有自己的一个交易钱包，私钥和钱你随时可以拿走。除了你要求的交易和事先告知的手续费，一分钱都不会动。

这是第一条规矩，写在代码里，有测试盯着，不是写在承诺里。

4/
先试再充。

模拟盘跑的是同一条行情、同一套规则、同一套出场，只是用假钱。不买不卖，不收费。

先看它怎么干活，再决定要不要上车。青蛙很坚持这一点。

5/
亏损在发生之前就被框住，不是事后解释。

止损盯着仓位自己的价格，每个 tick 都在算。卖出永远不低于曲线报价的 85%。今天亏得越多，它下注越小，一路收紧到停手。

没有梭哈这个选项。

6/
每个群都有“喊单”。

我们的喊单只有一点不同：喊的是成交。机器人真金白银买了，交易哈希在链上，谁都能查。

不是观点，是收据。

7/
每一笔喊单在发到任何地方之前，先写进账本并哈希：sha256(venue|instrument|tx|ts|mcapUsd|tier|plan)。

之后改不了、删不掉、也倒填不了日期。平仓同样这么发。

亏的那些，留在记录上。

8/
模拟单不发。评级不够的单不发。同一个币每小时最多喊一次，所有用户共用这个额度。任何一行都不写钱包、不写用户。

只晒盈利单的群，正是我们不想成为的东西。

9/
费用：每笔盈利交易的 5%，从利润里扣。亏的单子一分不收。

没有订阅费，没有锁仓。钱包里有一个 $BNDLI，就是 0%。

费用就这一条。

10/
$BNDLI。

名字 Bondli，代码 BNDLI，Solana 上的 SPL 代币，在 pump.fun 发射。

你登录用的那个钱包里有一个，不管在哪条链上交易，手续费都是 0%。

它只干这件事，也只干这一件事。

11/
$BNDLI 不是什么：不是股份，不是承诺，不是收益。

机器人不会替任何人买它，看它这个盘跟看别的盘一样：不偏心，不自动买。

土狗可以归零，这个也一样。只拿亏得起的钱。青蛙是带着爱说这句话的。

12/
查不了的绿K线是睡前故事。

Bondli 发的是自己的成交，发之前先哈希，亏的也发。模拟单一律不算。

是机器人干的，不是我。🐸

https://bondli.fun

## 单发（简体中文）

A.（从一笔真实平仓填数字；Calls 页的分享按钮给出的是英文版，中文照这个格式手填，{{HELD}} 写成“4 分钟”这样的中文）
{{PNL}}% 的 ${{TICKER}}，拿了 {{HELD}}。是机器人干的，不是我 🐸
{{TX}}

B.
成交了。feels good man。
这条发出去之前，账本里已经有它的哈希了。要是后面亏了，一样发。 https://bondli.fun

C.
路线图。
第一阶段：青蛙喝咖啡。
第二阶段：机器人打新盘头几分钟，把干过的每一件事记下来。
第三阶段：见第一阶段。
没有路线图，只有账本。

D.
没有隐藏费用，不锁仓，亏的单子不收钱。钱包里有一个 $BNDLI，手续费 0%。
规矩就这一条。 https://bondli.fun

E.
狗累了，青蛙喝完咖啡了。
先跑模拟盘，钱包在你手里，每一笔喊单都是真实成交，亏的也算。想上车的，先看账本再冲。
https://bondli.fun
