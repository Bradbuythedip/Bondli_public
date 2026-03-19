<p align="center">
  <img src="hero.png" alt="bondli" width="100%" />
</p>

# bondli

**if you know, you know.**

---

bondli is an intelligence layer for Solana meme tokens. it watches everything, scores everything, learns from everything, and never sleeps.

built because we were tired of losing money to rugs, snipers, and fake charts — so we taught a machine to see what humans can't.

---

## the brain

```
                    ┌──────────────────────────────────────────────┐
                    │                 BONDLI BRAIN                 │
                    ├──────────────────────────────────────────────┤
                    │                                              │
  INPUT             │  PumpPortal ──► Scanner ──► Scorer   Smart$  │
                    │       ↓            ↓          ↓        ↓     │
                    │  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │
  PROCESS           │  Social ─► Artwork ─► CORTEX ─► GameTh ─► Rug│
                    │                        ◉ hub                 │
                    │  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │
  OUTPUT            │     APE       WATCH      SKIP       RUG      │
                    │      ↓          ↓          ↓         ↓       │
                    │  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │
  LEARN             │  Learner   GradWatch  Survivor   Patterns    │
                    │      ↑          ↑          ↑         ↑       │
                    │      └──────────┴──── ◉ ───┴─────────┘       │
                    │            feedback → retrain model           │
                    └──────────────────────────────────────────────┘
```

17 modules. 4 tiers. every token passes through all of them before a decision is made.

---

## what it does

### intelligence & scoring

- **40+ feature ML scoring** — behavioral economics (Kahneman), network effects (Tipping Point), on-chain forensics, chart shape analysis, social signals. weighted, learned, updated on every outcome.

- **score dynamics** — the score itself lags. the *velocity* and *acceleration* of the score are leading indicators. by the time a token's score drops, the derivatives already told you 2 cycles ago. physics applied to meme coins.

- **survivorship bias engine** — stores feature snapshots of every winner and loser. Fisher's linear discriminant analysis per feature. cosine similarity to a "survivor archetype" built from tokens that actually graduated. kill signals for dead-zone exclusion.

- **game theory engine** — real-time opponent modeling. Bayesian wallet classification: snipers, whales, bots, retail, accumulators. posterior probability updates on each trade. Nash equilibrium shift detection.

- **memetic pipeline** — stateless meme scoring in two passes. quick 3-module pre-filter (<50ms), then full 7-module deep score via workers. language processing, absurdity detection, KOL/trend polling.

- **velocity-potential scoring** — separates what already moved from what will move. MCap headroom, liquidity/mcap ratio, holder quality, bonding curve progress. identifies the goldilocks zone.

- **meta engine** — narrative tracking across 8 categories (animals, AI, political, celebrity, culture, DeFi, food, absurdist). Signal Detection Theory optimization (d' & beta) for entries during peak metas.

### security & rug detection

- **12+ rug signals** — dev sell speed, coordinated dumps, sybil bots, wash trading, holder concentration, liquidity drain, flatline-spike patterns, pump-and-dump shapes, quick-flip detection. 3 moderate signals = hard reject.

- **artwork originality scanner** — perceptual hashing catches duplicates even when resized, compressed, or cropped. exact content hash matching. entropy analysis. AI-generated image detection.

- **dev wallet profiling** — balance monitoring, launch history, rug rate calculation, serial rugger identification. $0 balance dev? penalty. 12 launches and 10 rugs? hard reject.

- **chart pattern recognition** — stores the price curve of every token. classifies into trajectory patterns (pump, consolidation, grind, crash). learns which shapes graduate vs rug.

### smart money & social

- **smart money tracker** — identifies consistently profitable wallets. leaderboard ranking by win rate, avg return, consistency. polls top wallets for new buys via RPC. emits signals before radar picks up the token.

- **X/Twitter social intel** — profile verification, account age, follower/following ratio (bot detection), engagement scoring, sentiment analysis. fake social = rug signal.

- **wallet age cache** — on-chain wallet age tracking. aged wallets buying = real users. fresh wallets clustered = likely sybils.

### trading

- **auto-ape** — walk-away trading. set parameters, it finds tokens, enters, manages positions, takes profits, cuts losses, exits on momentum collapse. 3-layer exit: derivatives first, absolute thresholds second, trailing stops third.

- **quick-ape** — one-click sniping with configurable slippage, priority fees, and Jito tips.

- **position management** — live P&L, dual-axis analytics (score + price overlaid), TP/SL zones, batch sell-all, emergency recovery.

- **simulation mode** — dry-run auto-trading with real signals and real settings. validate strategy before risking SOL.

### deployment

- **token deploy wizard** — create and launch tokens directly from the dashboard. name, ticker, image, socials. pre-built presets (Quick, Scout, Standard, Swarm).

- **fleet trading** — multi-wallet coordinated launches with independent wallet personalities. see [axiomatic design](#axiomatic-design).

---

## fee system — win more, pay less

bondli's fee model is designed so that **winning is the unlock**.

```
┌─────────────────────────────────────────────────────────┐
│                    PROFIT LADDER                        │
├──────────────┬──────────┬───────────────────────────────┤
│  lifetime    │   fee    │  tier                         │
├──────────────┼──────────┼───────────────────────────────┤
│  0 SOL       │   25%    │  Bronze                       │
│  1+ SOL      │   20%    │  Silver                       │
│  5+ SOL      │   15%    │  Gold                         │
│  15+ SOL     │   10%    │  Platinum                     │
│  50+ SOL     │    5%    │  Diamond                      │
├──────────────┼──────────┼───────────────────────────────┤
│  Pro (1 SOL) │    0%    │  flat access                  │
│  VIP (10 SOL)│    0%    │  full sovereignty             │
└──────────────┴──────────┴───────────────────────────────┘

+ win streak bonus:  -2% per consecutive win (up to -10%)
+ share-to-earn:     share wins → earn fee credits
+ referrals:         20-40% of platform revenue from referrals
```

### share-to-earn (viral loop)

every profitable trade generates a **win card** — a shareable snapshot of your trade. shows your profit, hold time, streak, and ladder tier.

when someone signs up through your win card link, **you earn fee credits** that reduce your next fees. the best traders become the best advertisers — automatically.

the mechanic: **winning → sharing → growing → winning**. the platform markets itself through the performance of its users.

---

## axiomatic design

the fleet trading system is built on 7 non-negotiable axioms.

```
AXIOM 1  Every wallet is an independent actor.
         No coordinated on-chain footprint. Each wallet has its own
         personality, risk tolerance, timing, and decision function.

AXIOM 2  Volume is oxygen — but only when we're alone.
         externalBuyers = 0  →  volume HIGH (we are the market)
         externalBuyers = 1  →  volume MEDIUM (someone found us)
         externalBuyers ≥ 2  →  volume OFF (they ARE the market)
         externalBuyers ≥ 3  →  START SELLING (exit into their demand)

AXIOM 3  The bonding curve is the only truth.
         pump.fun graduation at ~$69K MC. Every action pushes toward
         graduation or profits before the dump.

AXIOM 4  Dev buy is the foundation — dev sell is profit.
         Dev never sells first. Dev sells LAST, after fleet distributes.

AXIOM 5  Sell into demand, never into vacuum.
         Only sell when external buy pressure exists.

AXIOM 6  Information asymmetry is our edge.
         External traders don't know which wallets are ours.

AXIOM 7  Time pressure creates urgency.
         Tokens die without movement in 10 min. Volume must peak
         in a 3-5 minute window.
```

each wallet runs its own **brain** — one of 5 personality archetypes:

| brain | style | sells when |
|---|---|---|
| `degen_aper` | aggressive, fast entry | momentum turns negative |
| `accumulator` | patient, DCA in | profit target hit (2-3x) |
| `whale_bluffer` | large single buys | time-based exit (60-120s) |
| `volume_painter` | micro-burst trades | external demand appears |
| `momentum_rider` | reactive, follows flow | chart shape deteriorates |

brains have independent traits: aggression, patience, greed, fear factor, conviction. no two wallets behave the same way on-chain.

---

## repo structure

```
bondli/
├── app/                          # frontend (React/Vite)
│   └── src/
│       ├── App.jsx               # main app — radar, wallet, intel, deploy tabs
│       ├── IntelDashboard.jsx    # intel analytics panel
│       ├── MemeticRadar.jsx      # token radar view
│       ├── api.js                # API client
│       └── lib/                  # shared utilities
│
├── src/
│   ├── api/
│   │   ├── server.production.mjs # production server (Express + WS + all routes)
│   │   ├── server.mjs            # development server
│   │   └── access-check.mjs      # tier access control
│   │
│   └── engine/                   # 32 engine modules
│       ├── meme-intelligence.mjs # core ML scoring (40+ features, online learning)
│       ├── memetic-pipeline.mjs  # 7-module meme DNA scoring pipeline
│       ├── survivorship-bias.mjs # Fisher discriminant survivor archetype matching
│       ├── game-theory.mjs       # Bayesian opponent modeling + Nash equilibrium
│       ├── meta-engine.mjs       # narrative tracking (8 categories, SDT)
│       ├── velocity-scorer.mjs   # velocity vs potential separation
│       ├── trajectory-classifier.mjs  # price curve classification
│       │
│       ├── rug-scanner.mjs       # token safety checks (12+ signals)
│       ├── artwork-scanner.mjs   # perceptual hash image forensics
│       ├── dev-wallet-tracker.mjs # creator profiling + serial rugger detection
│       ├── smart-money-tracker.mjs # profitable wallet following
│       ├── x-social-intel.mjs    # X/Twitter validation + sentiment
│       ├── signal-detector.mjs   # wallet profiling via Tatum RPC
│       │
│       ├── fleet-brains.mjs      # 7 axioms + 5 wallet personalities
│       ├── fleet-trader.mjs      # fleet trading v4 (organic + game theory)
│       ├── volume-engine.mjs     # continuous volume painting + auto-rug
│       ├── anti-detection.mjs    # human-like timing + trade patterns
│       ├── wallet-optimizer.mjs  # Kelly sizing + role assignment
│       │
│       ├── fee-engine.mjs        # profit ladder + share-to-earn + referrals
│       ├── session-manager.mjs   # trading session lifecycle
│       ├── trade-router.mjs      # PumpFun vs Raydium routing
│       ├── orchestrator.mjs      # multi-CA phase orchestration
│       │
│       ├── pumpfun-client.mjs    # pump.fun bonding curve client
│       ├── raydium-client.mjs    # Raydium/Jupiter post-grad trading
│       ├── token-creator.mjs     # pump.fun token deployment
│       ├── rpc-enhanced.mjs      # priority fees + optimized tx sending
│       ├── alchemy-client.mjs    # Alchemy SDK integration
│       │
│       ├── historical-movers.mjs # DexScreener/Birdeye top performers
│       ├── exit.mjs              # position exit + SOL sweep
│       ├── recover.mjs           # fund recovery (sub-wallet scan)
│       ├── wallet-saver.mjs      # seed persistence for recovery
│       └── config.mjs            # environment configuration
│
├── deploy/                       # deployment scripts
├── hero.png                      # hero image
├── package.json
└── README.md
```

---

## the stack

```
frontend    React/Vite — radar, wallet, intel dashboard, deploy wizard
backend     Node.js/Express — WebSocket feeds, scoring pipeline, auto-trader
chain       Solana mainnet — Helius RPC, PumpPortal Lightning, Jito bundles
memory      Redis — sessions, learned weights, chart patterns, artwork hashes
intel       Custom ML — online learning, RAG memory, 100+ feature extractors
social      X/Twitter API — profile validation, engagement scoring, sentiment
```

---

## philosophy

most trading tools show you data. bondli makes decisions.

the core insight is borrowed from physics: **position is a lagging indicator. velocity and acceleration are leading indicators.** applied to token scores, this means we can detect rug pulls and runners *before* the price moves — by watching how fast the score is changing and whether that change is accelerating or decelerating.

the scoring draws from three frameworks:

- **Kahneman's System 1/2** — how do humans actually decide what to buy? cognitive ease, emotional valence, herd signals, anchoring bias, loss aversion. model the psychology, predict the crowd.

- **Gladwell's Tipping Point** — what makes a token tip from obscurity to virality? connectors (influencers), mavens (alpha wallets), salesmen (viral tweets). the law of the few. stickiness. context.

- **Game Theory** — every trade is a move in a game with imperfect information. classify opponents (Bayesian posteriors), detect equilibrium shifts, exploit information asymmetry. cooperate when the game is positive-sum, defect when it's not.

combine these with hard on-chain data (buy velocity, holder distribution, dev behavior, chart shape) and you get something that understands *both* the math and the psychology of why tokens pump.

---

## what makes it different

1. **it learns** — not static rules. online ML with gradient updates on every outcome.

2. **derivatives, not thresholds** — exits when d(score)/dt is collapsing. 1-2 cycles earlier than price.

3. **survivorship analysis** — Fisher discriminant + cosine similarity to the survivor archetype.

4. **artwork forensics** — perceptual hashing, entropy analysis, AI-generation detection. stolen art = rug.

5. **opponent modeling** — Bayesian classification of every wallet. knows bots from real users.

6. **axiomatic fleet design** — 7 hard constraints, 5 personality archetypes. sells into demand, not vacuum.

7. **win more, pay less** — the fee ladder rewards profitable traders. winning is the unlock.

8. **viral by design** — share-to-earn win cards make every winning trade an advertisement.

9. **it never sleeps** — 24/7 WebSocket monitoring. auto-ape, auto-exit, auto-learn.

---

## access tiers

| tier | fee | what you get |
|---|---|---|
| **free** | 25% → 5% (ladder) | radar, scoring, rug detection, chart patterns, quick-ape, profit ladder |
| **pro** | 0% | auto-ape, smart money signals, artwork forensics, survivor analysis, simulation |
| **vip** | 0% | fleet trading, deploy wizard, dev wallet profiling, referral dashboard |

---

## status

live on Solana mainnet. learning every day.

**$BONDLI** — [pump.fun](https://pump.fun)

---

*"if you want to make enemies, try to change something."*

---

MIT License
