# bondli

**if you know, you know.**

---

bondli is an intelligence layer for Solana meme tokens. it watches everything, scores everything, learns from everything, and never sleeps.

built because we were tired of losing money to rugs, snipers, and fake charts — so we taught a machine to see what humans can't.

---

## what it does

- **real-time radar** — every new token on pump.fun, scored and ranked as it launches. no APIs to scrape, no delays. direct WebSocket feed.

- **40+ feature ML scoring** — not vibes, not "trust me bro." behavioral economics (Kahneman), network effects (Tipping Point), on-chain forensics, chart shape analysis, social signals. weighted, learned, updated on every outcome.

- **score dynamics** — the score itself lags. the *velocity* and *acceleration* of the score are leading indicators. by the time a token's score drops, the derivatives already told you 2 cycles ago. physics applied to meme coins.

- **rug detection** — dev sell speed, coordinated dumps, sybil bots, wash trading, holder concentration, liquidity drain, fake charts with no natural dips. 12+ signals. 3 moderate signals = hard reject before scoring even starts.

- **artwork originality scanner** — stolen images are one of the biggest rug signals. perceptual hashing catches duplicates even when resized or compressed. exact match? instant reject. similar? penalized.

- **chart pattern recognition** — stores the price curve of every token it sees (not just winners). classifies into patterns. learns which shapes graduate vs rug.

- **auto-ape** — walk-away trading. set your parameters, it finds tokens, enters, manages positions, takes profits, cuts losses, and exits on momentum collapse. 3-layer exit system: derivatives first, absolute thresholds second, trailing stops third.

- **game theory engine** — real-time opponent modeling. classifies wallets as snipers, whales, bots, retail. detects Nash equilibrium shifts. dev selling? defect first. whale buying? cooperate.

- **self-improving** — every token outcome feeds back into the model. weights adjust. accuracy improves. the system that trades on day 100 is fundamentally different from day 1.

---

## the stack

```
frontend    React/Vite — radar, bags, intel dashboard, deploy wizard
backend     Node.js/Express — PumpPortal WS, scoring engine, auto-trader
chain       Solana mainnet — Helius RPC, PumpPortal Lightning trades
memory      Redis — sessions, learned weights, chart patterns, artwork hashes
intel       Custom ML — online learning, RAG memory, feature extraction
```

---

## philosophy

most trading tools show you data. bondli makes decisions.

the core insight is borrowed from physics: **position is a lagging indicator. velocity and acceleration are leading indicators.** applied to token scores, this means we can detect rug pulls and runners *before* the price moves — by watching how fast the score is changing and whether that change is accelerating or decelerating.

the scoring draws from two frameworks:

- **Kahneman's System 1/2** — how do humans actually decide what to buy? cognitive ease, emotional valence, herd signals, anchoring bias, loss aversion. model the psychology, predict the crowd.

- **Gladwell's Tipping Point** — what makes a token tip from obscurity to virality? connectors (influencers), mavens (alpha wallets), salesmen (viral tweets). the law of the few. stickiness. context.

combine these with hard on-chain data (buy velocity, holder distribution, dev behavior, chart shape) and you get something that understands *both* the math and the psychology of why tokens pump.

---

## what makes it different

1. **it learns** — not static rules. online ML with gradient updates on every outcome. the model gets better at detecting rugs because it's seen thousands.

2. **derivatives, not thresholds** — most systems exit when score < X. bondli exits when d(score)/dt is collapsing. 1-2 cycles earlier. that's the difference between profit and bag-holding.

3. **artwork forensics** — nobody else checks if the token image is stolen. bondli does. perceptual hashing, entropy analysis, exact duplicate detection. stolen art = rug.

4. **it never sleeps** — 24/7 WebSocket monitoring. auto-ape, auto-exit, auto-learn. set it and forget it.

---

## status

live on Solana mainnet. learning every day.

**$BONDLI** — [pump.fun](https://pump.fun)

---

*"if you want to make enemies, try to change something."*

---

MIT License
