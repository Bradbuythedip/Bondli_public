# Bondli — Architecture Overview

## Stack

```
┌──────────────────────────────────────────────────────────────┐
│                          BONDLI STACK                             │
├──────────────────────────────────────────────────────────────┤
│                                                                   │
│  FRONTEND         React/Vite SPA — 5 tabs (URL-routed)           │
│                   Radar · Wallet · Deploy · Intel · GPU           │
│                                                                   │
│  BACKEND          Node.js/Express + WebSocket                     │
│                   Real-time scoring, trading, GPU management      │
│                                                                   │
│  DATA             Redis — sessions, ML weights, node registry,    │
│                   compute jobs, NOS burn tracking, premium stats  │
│                                                                   │
│  CHAIN            Solana mainnet — Alchemy RPC, PumpPortal,       │
│                   Jito bundles, Jupiter v6 swaps (SOL → NOS)      │
│                                                                   │
│  GPU SUPPLY       Nosana Network — @nosana/kit v2.2.4 SDK        │
│                   gpu-earnings.mjs — node registration, earnings  │
│                   nosana-job-router.mjs — AI inference routing    │
│                                                                   │
│  GPU DEMAND       compute-engine.mjs — job submission, SOL→NOS   │
│                   premium-compute.mjs — 9 alpha tools, NOS burn  │
│                   nosana-client.mjs — SDK + REST API client       │
│                                                                   │
│  ML               Custom LoRA — online learning, 115 features     │
│                   <5ms inference, trains on outcomes              │
│                                                                   │
│  SOCIAL           X/Twitter API — profile, engagement, KOL       │
│                                                                   │
│  AI               xAI Grok 4 — GPU support chat                  │
│                   BRAD — autonomous trading AI companion          │
└──────────────────────────────────────────────────────────────┘
```

## The Brain

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

## GPU Pipeline

```
  USER ACTION                 BONDLI                      NOSANA
  ───────────                 ──────                      ──────
  Click "Run"  ──►  premium-compute.mjs  ──►  Jupiter SOL→NOS swap
                           │                        │
                    Build Docker job def     NOS sent to market
                           │                        │
                    Submit to Nosana  ───────►  GPU node picks up job
                           │                        │
                    Poll for result  ◄───────  Docker container runs
                           │                        │
                    WS broadcast result             NOS burned ✓
                           │
                    Redis: track burn stats
```

---

*See also: [Technical Architecture](TECHNICAL_ARCHITECTURE.md) for full system diagrams.*
