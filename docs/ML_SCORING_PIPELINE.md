# ML Scoring Pipeline

```
  New Token Launch (PumpPortal WebSocket)
         │
         ▼
  ┌──────────────────────────────────────────────────────────┐
  │                     Feature Extraction                        │
  │                                                               │
  │  On-Chain (20+)        Social (10+)        Visual (5+)       │
  │  ├─ Holder distrib.    ├─ Twitter signals   ├─ Artwork hash  │
  │  ├─ Buy/sell pressure  ├─ KOL detection     ├─ Duplicate     │
  │  ├─ Wallet ages        ├─ Engagement rate   │  detection     │
  │  ├─ Dev wallet profile ├─ Follower quality  ├─ Meme DNA      │
  │  ├─ Liquidity depth    └─ Post frequency    └─ Cultural      │
  │  ├─ Chart patterns     └─ Sentiment              timing      │
  │  └─ Sybil clustering                                         │
  └─────────────────────┬────────────────────────────────────┘
                         │
                         ▼
  ┌──────────────────────────────────────────────────────────┐
  │              LoRA Neural Network (128d, 4-layer, rank-16)    │
  │              <5ms inference — online learning from outcomes   │
  └─────────────────────┬────────────────────────────────────┘
                         │
                         ▼
  ┌──────────────────────────────────────────────────────────┐
  │  Score (0-100) + Velocity + Acceleration + Rug Probability   │
  │                                                               │
  │  Decision:  APE (80+)  │  WATCH (40-79)  │  SKIP (<40)      │
  │             + RUG override if 3+ signals detected             │
  └──────────────────────────────────────────────────────────┘
```

---

*Bondli v3.0 — Live on Solana Mainnet*

*Part of the [Technical Architecture](TECHNICAL_ARCHITECTURE.md) documentation.*
