# Bonding Curve Mechanics (pump.fun)

Constant-Product AMM:

```
price = virtualSolReserves / virtualTokenReserves
```

At creation: ~30 SOL virtual reserves, ~1B virtual tokens
Initial price: 30 / 1,000,000,000 = 0.00000003 SOL/token

```
┌──────────────────────────────────────────────────────────┐
│  Price                                                        │
│  ▲          Graduation Threshold                              │
│  │          ($67K mcap)                                       │
│  │              ╱─────── Migrates to Raydium AMM              │
│  │            ╱                                               │
│  │          ╱     ◀── Bondli ML detects                       │
│  │        ╱           momentum shifts here                    │
│  │      ╱                                                     │
│  │    ╱   ◀── Score velocity + acceleration                   │
│  │  ╱         detect deterioration 2 cycles                   │
│  │╱           before price drops                              │
│  ├──────────────────────────────────────────────▶ Supply      │
│  Launch                                                       │
└──────────────────────────────────────────────────────────┘
```

Bondli's ML Engine monitors:
- **Score velocity** (first derivative — rate of change)
- **Score acceleration** (second derivative — change of rate)
- **12+ rug signals** (dev dumps, sybils, wash trades)
- **3-layer exit** (derivatives → thresholds → trailing stops)

---

*Part of the [Technical Architecture](TECHNICAL_ARCHITECTURE.md) documentation.*
