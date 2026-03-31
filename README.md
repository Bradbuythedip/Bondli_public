<p align="center">
  <img src="hero.png" alt="bondli" width="100%" />
</p>

# bondli

**ML-powered Solana trading terminal.** Scores every token. Exits before the rug. Burns NOS on Nosana GPUs.

[![Live](https://img.shields.io/badge/Live-bondli.fun-00ff88?style=flat-square)](https://bondli.fun)
[![Twitter](https://img.shields.io/badge/Twitter-@Bondlifun-1DA1F2?style=flat-square)](https://x.com/Bondlifun)
[![Nosana](https://img.shields.io/badge/GPU-Nosana%20Network-8B5CF6?style=flat-square)](https://nosana.com)

---

## What is Bondli?

Bondli is an AI-powered trading terminal for Solana memecoins built on [Nosana](https://nosana.com) decentralized GPU compute. It watches every token launch in real-time, scores them with 40+ ML features, detects rugs before they happen, and trades autonomously — all powered by GPU inference on Nosana nodes.

**The edge:** Score derivatives (velocity + acceleration) detect deterioration 2 cycles before price drops. Three exit layers fire automatically — by the time you'd notice the chart, Bondli already sold.

**The NOS burn:** Every GPU operation — from ML scoring to premium alpha tools — burns $NOS tokens on the Nosana network. Users pay SOL, Bondli swaps to NOS via Jupiter, NOS gets burned on GPU jobs. Self-sustaining demand flywheel from the pump.fun ecosystem.

**Tiers:** Free (radar + scoring), Pro (auto-trading), VIP (GPU Alpha Tools + compute job submission + smart money signals).

**Direct links:**
- [bondli.fun/radar](https://bondli.fun/radar) — Live token radar with ML scoring
- [bondli.fun/gpu](https://bondli.fun/gpu) — GPU earnings, Alpha Tools, compute jobs
- [bondli.fun/intel](https://bondli.fun/intel) — AI trading intelligence + auto-ape
- [bondli.fun/wallet](https://bondli.fun/wallet) — Portfolio + positions
- [bondli.fun/deploy](https://bondli.fun/deploy) — Launch tokens on pump.fun / Bags.fm

---

## Documentation

| Document | Description |
|----------|-------------|
| [API Reference](docs/BONDLI_API.md) | Complete REST API documentation |
| [GPU & Nosana Guide](docs/GPU_NOSANA_GUIDE.md) | GPU earnings setup and management |
| [GPU Training Guide](docs/GPU_TRAINING_GUIDE.md) | LoRA model training and inference |
| [Technical Architecture](docs/TECHNICAL_ARCHITECTURE.md) | Full system architecture diagrams |
| [Architecture Overview](docs/ARCHITECTURE_OVERVIEW.md) | Stack, brain, and GPU pipeline diagrams |
| [GPU Earnings Deep Dive](docs/GPU_EARNINGS_DEEP_DIVE.md) | Supply/demand mechanics, NOS burn flow |
| [Repo Structure](docs/REPO_STRUCTURE.md) | Full codebase file tree |
| [Quick Start & Config](docs/QUICKSTART.md) | Setup, env vars, NPM scripts, Redis schema |
| [Grant Proposal](docs/GRANT_PROPOSAL.md) | Nosana grant proposal one-pager |
| [Grant Application](docs/NOSANA_GRANT_ANSWERS.md) | Detailed Nosana grant application |

**Related:** [BRAD](https://github.com/Bradbuythedip/brad) — Self-aware AI trading brain (cognitive sidecar for Bondli)

---

## How Bondli Uses Nosana GPU

| Feature | Status | Description |
|---------|--------|-------------|
| **ML Scorer** | ACTIVE | 40+ features scored per token in real-time. Rug detection, chart forensics, buy pressure — all computed on GPU inference via Nosana nodes. |
| **Artwork Forensics** | ACTIVE | Every token image scanned for copy/paste rugs, template art, and AI-generated fakes. GPU-accelerated perceptual hashing and CLIP embeddings. |
| **Monte Carlo Simulator** | Q3 2026 | 10,000 path simulations per new pair — modeling entry timing, position sizing, and exit triggers. Every possible trade scenario stress-tested before capital is deployed. |
| **Live Model Retraining** | Q4 2026 | Weekly weight recalibration using real trade outcomes. Users burn NOS to retrain the scoring model on their own trading data — better entries, better exits, better win rates. |

---

## Features

### ML Token Scoring (GPU-Powered)
- **40+ features** extracted from every launch — holder distribution, chart patterns, wallet age, buy/sell pressure, social signals
- GPU inference via Nosana nodes for real-time scoring (<5ms per token)
- Model learns from every trade outcome and updates weights live
- Score velocity + acceleration are leading indicators (detect problems before price drops)
- Survivorship bias engine: Fisher's discriminant analysis + cosine similarity to "survivor archetype"
- Memetic DNA scoring: linguistic analysis, absurdity detection, cultural timing, KOL influence

### Rug Detection (GPU-Powered)
- **12+ signals** — dev dumps, sybil wallets, wash trading, staircase charts, liquidity drains, holder concentration
- 3+ moderate signals = auto-reject
- GPU-accelerated artwork scanner with perceptual hashing catches duplicates even when resized/compressed
- CLIP embeddings detect AI-generated fakes and template art
- Dev wallet profiling: balance monitoring, launch history, serial rugger identification
- Volume legitimacy analysis: detects wash trading patterns and artificial demand

### Auto-Ape Engine
- Walk-away autonomous trading — finds tokens, enters, manages positions, exits
- 3-layer exit system: score derivatives first, absolute thresholds second, trailing stops third
- Configurable rules: min score, position size, take-profit levels, stop-loss
- Live simulation mode to test strategies before going live
- Kelly criterion position sizing
- Portfolio correlation limits to prevent over-exposure

### Smart Money Tracking
- Identifies consistently profitable wallets on Solana
- **SOL balance tracking** with 5-minute cache refresh
- **Wallet categorization**: whale (>10 SOL avg), sniper (high frequency), accumulator (steady >50% WR), mixed
- Tier scoring (S/A/B/C) based on trade performance
- VIP/owner can manually add/remove wallets from watchlist
- Configurable poll interval and max wallet count
- Signals before radar picks up the token

### GPU Alpha Tools (Premium — NOS Burn)
Pay-per-use GPU-powered tools. Each use burns $NOS on Nosana's network.

| Tool | Price | Category | Description |
|------|-------|----------|-------------|
| **Deep Rug Scanner** | 0.005 SOL | Scan | Forensic token analysis — on-chain + social + code decompilation |
| **Entry Simulator** | 0.01 SOL | Simulate | Monte Carlo entry timing with 5,000 path simulations |
| **Wallet X-Ray** | 0.008 SOL | Scan | Deep-profile any wallet — 90-day history, cluster analysis |
| **Exit Timing AI** | 0.005 SOL | Simulate | Optimal exit path modeling with 5,000 simulations |
| **Launch Simulator** | 0.02 SOL | Simulate | Pre-launch 10K scenario simulation |
| **MEV Protection** | 0.01 SOL | Protect | Sandwich bot detection and trade protection |
| **Portfolio Rebalancer** | 0.02 SOL | Optimize | AI-optimized position rebalancing |
| **Custom LoRA Model** | 0.1 SOL/wk | Subscribe | Train on your own trade history — personal scoring model |
| **Chart Pattern CNN** | 0.05 SOL/wk | Subscribe | AI pattern recognition: accumulation, distribution, breakout, trap, divergence |

- Deep Rug Scan available as one-click shortcut on every token card in Radar
- Results delivered via WebSocket in real-time
- 25% Bondli margin on all premium features

### Compute Job Submission (VIP)
- Submit custom Docker containers to Nosana GPU marketplace
- Quick-select templates: Scorer, Ollama, vLLM
- Market selector: RTX 3060 through H100
- Live cost estimation (NOS + SOL) with 15% Bondli margin
- SOL → NOS swap via Jupiter v6 API
- Job history table with real-time status updates via WebSocket
- Persistent deployments with health checks

### NOS Burn Flywheel

```
Users pay SOL → Bondli swaps to NOS (Jupiter) → NOS burned on GPU job
     ↓                                                    ↓
  Better tools ← GPU node earns NOS ← Job completed on Nosana
     ↓
  More users → More NOS demand → Higher NOS value → More node operators
```

Users burn $NOS to run alpha tools → better tools improve win rates → more profitable traders need more GPU → more NOS burned. Self-sustaining demand from the pump.fun ecosystem.

**Projected at scale:** 100 users × 3 features/day ≈ 1 NOS/day burned, scaling linearly with adoption.

### Token Radar
- Real-time feed of every token launch on pump.fun and Bags.fm
- Tabs: **Momentum** (sustained buying), **Hot** (buy activity), **New** (fresh launches), **Resurgence** (comeback plays)
- Source filter: filter by BAGS or PUMP tokens within any tab
- Entry signals: STRONG / READY / EARLY indicators
- Buy pressure bars, sparkline charts, memetic DNA scores
- One-click Deep Rug Scan on any expanded token card

### Token Deployment
- Launch tokens on pump.fun or Bags.fm (Meteora DBC)
- Bags.fm: 1% perpetual creator royalty on all volume, top 100 holders get dividends
- Fleet trading with multi-wallet coordination
- Session management: sweep, close, export keys

### GPU Earnings
- Plug in your NVIDIA GPU, earn $NOS tokens via Nosana decentralized compute
- One-command setup: `curl -s https://bondli.fun/gpu-agent.sh | bash -s -- --wallet <WALLET>`
- Remote node control from dashboard: restart, stop, view logs, GPU details
- Power consumption, fan speed, VRAM utilization, clock rates monitored in real-time
- 1 user = 1 GPU = 1 node = 1 keypair
- Laptop GPUs matched to Nosana markets by VRAM tier
- 90-95% of earnings to user, remainder to treasury (hourly sweep)

### AI Chat Support (Grok 4)
- Built-in assistant powered by xAI's Grok 4, trained on Bondli + Nosana GPU knowledge
- Knows about GPU Alpha Tools, NOS burn flywheel, node setup, earnings, troubleshooting
- Context-aware: understands your node status, tier, and feature access

---

## Philosophy

1. **GPUs should earn money when idle.** Nosana pays NOS tokens per second for AI inference. Bondli makes it one command.

2. **Trading tools should make decisions, not just show data.** Score derivatives apply physics to token analysis — velocity and acceleration are leading indicators.

3. **GPU demand should come from real usage.** Every premium alpha tool burns NOS on Nosana's network. Users get better trading tools, Nosana gets sustained demand — no artificial tokenomics.

4. **Tiered access, not paywalls.** Free users get the full radar + scoring engine. Pro unlocks auto-trading. VIP unlocks GPU Alpha Tools, compute jobs, and smart money signals. Value scales with commitment.

---

## Status

Live on Solana mainnet. GPUs earning. NOS burning. AI learning.

**$BONDLI** — [pump.fun](https://pump.fun) · **Nosana Partner** — [nosana.com](https://nosana.com)

---

MIT License
