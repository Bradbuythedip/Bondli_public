# Bondli — Technical Architecture Diagram

## System Overview: GPU Earnings, Nosana Integration & Bonding Curve

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          BONDLI PLATFORM ARCHITECTURE                            │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │                         FRONTEND (React/Vite SPA)                       │     │
│  │                                                                         │     │
│  │   ┌─────────┐  ┌────────┐  ┌────────┐  ┌───────┐  ┌──────────────┐   │     │
│  │   │  Radar  │  │ Wallet │  │ Deploy │  │ Intel │  │ GPU Dashboard│   │     │
│  │   │ Token   │  │ Fleet  │  │ Launch │  │ Smart │  │ Node Status  │   │     │
│  │   │ Scanner │  │ Mgmt   │  │ Tokens │  │ Money │  │ Earnings     │   │     │
│  │   └────┬────┘  └───┬────┘  └───┬────┘  └──┬────┘  └──────┬───────┘   │     │
│  │        └────────────┴──────────┴───────────┴──────────────┘           │     │
│  │                          REST + WebSocket                              │     │
│  └──────────────────────────────────┬──────────────────────────────────┘     │
│                                     │                                            │
│  ═══════════════════════════════════╪════════════════════════════════════════    │
│                                     │                                            │
│  ┌──────────────────────────────────┴──────────────────────────────────┐     │
│  │                    BACKEND (Node.js/Express + WS)                       │     │
│  │                                                                         │     │
│  │  ┌───────────────────────────────────────────────────────────────┐  │     │
│  │  │                        API Layer                                  │  │     │
│  │  │  /api/gpu/*    /api/trade/*   /api/radar/*   /api/payment/*      │  │     │
│  │  │  /api/deploy/* /api/intel/*   /api/chat/*    /api/health         │  │     │
│  │  └───────────┬───────────┬──────────────┬───────────────────────────┘  │     │
│  │              │           │              │                               │     │
│  │  ┌───────────▼───┐  ┌───▼──────────┐  ┌▼───────────────────────────┐  │     │
│  │  │  GPU ENGINE   │  │  ML ENGINE   │  │     TRADING ENGINE         │  │     │
│  │  │               │  │              │  │                             │  │     │
│  │  │ gpu-earnings  │  │ 40+ Features │  │ Auto-Ape Pipeline          │  │     │
│  │  │ nosana-client │  │ LoRA Scorer  │  │ Fleet Trader               │  │     │
│  │  │ job-router    │  │ Rug Scanner  │  │ Exit Strategy              │  │     │
│  │  │ heartbeat     │  │ Velocity     │  │ Position Sizing (Kelly)    │  │     │
│  │  │ sweep cron    │  │ Survivor     │  │ Trade Router               │  │     │
│  │  │               │  │ Game Theory  │  │ Fee Engine                 │  │     │
│  │  └───────┬───────┘  └──────┬───────┘  └──────────┬────────────────┘  │     │
│  │          │                 │                      │                    │     │
│  │  ┌───────▼─────────────────▼──────────────────────▼────────────────┐  │     │
│  │  │                     Redis (State Layer)                         │  │     │
│  │  │  Sessions │ ML Weights │ Node Registry │ Earnings │ Positions  │  │     │
│  │  └────────────────────────────────────────────────────────────┘  │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## GPU Earnings Flow (Nosana Integration)

```
  GPU Owner                    Bondli Platform                Nosana Network
  ─────────                    ──────────────                ──────────────
      │                              │                             │
      │  1. curl gpu-agent.sh        │                             │
      │─────────────────────────────▶│                             │
      │                              │                             │
      │  2. Register node            │                             │
      │  (POST /api/gpu/register)    │                             │
      │─────────────────────────────▶│  3. Generate Solana keypair │
      │                              │────────────────────────────▶│
      │  4. Keypair + config         │                             │
      │◀─────────────────────────────│  (nosana_key.json)          │
      │                              │                             │
      │  5. Start Nosana node        │                             │
      │  (Docker container)          │                             │
      │─────────────────────────────────────────────────────────▶ │
      │                              │                             │
      │  6. Heartbeat every 60s      │                             │
      │  (POST /api/gpu/heartbeat)   │                             │
      │─────────────────────────────▶│  7. Accept AI inference job │
      │                              │◀────────────────────────────│
      │  8. Execute job on GPU       │                             │
      │◀─────────────────────────────│                             │
      │─────────────────────────────────────────────────────────▶ │
      │                              │                             │
      │                              │  9. $NOS reward to node     │
      │                              │◀────────────────────────────│
      │                              │                             │
      │  10. Hourly sweep            │                             │
      │  ┌───────────────────────────┤                             │
      │  │  90-95% ──▶ User wallet   │                             │
      │  │   5-10% ──▶ Treasury      │                             │
      │  └───────────────────────────┤                             │
      │                              │                             │
```
