# GPU Earnings — Deep Dive

Bondli is both a **supply-side** aggregator and **demand-side** client of the [Nosana](https://nosana.com) decentralized GPU compute network.

- **Supply side:** Users plug in their NVIDIA GPUs to earn $NOS tokens processing AI jobs
- **Demand side:** Bondli submits ML inference, rug scanning, and premium alpha tool jobs to Nosana

```
┌──────────────────────────────────────────────────────────┐
│                  BONDLI × NOSANA                          │
│                                                           │
│  SUPPLY (Earn NOS)          DEMAND (Burn NOS)            │
│  ─────────────────          ─────────────────            │
│  User A → RTX 4070 → NOS   ML Scorer → RTX 4090 job     │
│  User B → RTX 5070Ti→ NOS   Rug Scan → RTX 4090 job     │
│  User C → RTX 3090 → NOS   Alpha Tools → GPU jobs       │
│                              Compute Jobs → GPU jobs      │
│                                                           │
│  Each user = 1 node         SOL → NOS swap (Jupiter)     │
│  = 1 GPU = 1 keypair        NOS burned on every job      │
└──────────────────────────────────────────────────────────┘
```

## How GPU Earning Works

1. User runs the one-liner on their GPU machine
2. Agent registers with Bondli, gets a generated Solana keypair
3. Keypair written to `~/.nosana/nosana_key.json`, Nosana node starts
4. GPU accepts AI inference jobs from the Nosana marketplace
5. $NOS earnings flow to the node wallet
6. Bondli sweeps hourly: user gets 90-95%, remainder to treasury
7. All transfers on-chain, verifiable on Solana explorer

## How Alpha Tools Burn NOS

1. User pays SOL per feature (0.005–0.1 SOL)
2. Bondli swaps SOL → NOS via Jupiter v6 API (1% slippage)
3. NOS is spent submitting a GPU job to Nosana marketplace
4. GPU node processes the Docker container (rug scan, simulation, etc.)
5. Result delivered via WebSocket to user's frontend
6. 25% Bondli margin on premium features, 15% on raw compute jobs

## Remote Node Control

Commands are relayed via the heartbeat mechanism (queued → picked up within ~60s):

- **Restart Node** — restarts the Docker container
- **Stop Node** — stops the node (can restart from dashboard)
- **View Logs** — fetches last 50 lines of Docker logs
- **GPU Details** — power draw, fan speed, clock rates, VRAM utilization, driver version
- **Set Power Limit** — adjust GPU power limit remotely

## Supported GPUs & Nosana Market Rates

| GPU | ~NOS/sec | VRAM | Market Tier |
|-----|----------|------|-------------|
| RTX 3060 | 0.000043 | 12 GB | 12GB tier |
| RTX 4070 / Laptop 50-series | 0.000035 | 12 GB | 12GB tier |
| RTX 3090 | 0.00009 | 24 GB | 24GB tier |
| RTX 4090 / Desktop 5070+ | 0.000097 | 24 GB | 24GB tier |
| A100 | 0.000115 | 80 GB | 80GB tier |
| H100 | 0.000139 | 80 GB | 80GB tier |

Laptop GPUs are matched to Nosana markets by VRAM tier. Your 5070 Ti Laptop (8-12GB) joins the 12GB tier.

Also supports RTX 5070, 5080, 5090, A4000–A6500 — mapped to nearest VRAM tier.

## GPU API Endpoints

```
# ═══ Node Management (Supply Side) ═══
POST /api/gpu/register         — generate keypair, register node
POST /api/gpu/deregister       — sweep balance, remove node
GET  /api/gpu/dashboard        — node status, earnings, extended GPU metrics
POST /api/gpu/heartbeat        — agent reports metrics every 60s, receives commands
POST /api/gpu/job-completed    — agent reports completed Nosana job
GET  /api/gpu/fleet            — aggregate view of all Bondli GPU nodes
POST /api/gpu/command          — queue command for node (stop, restart, logs, etc.)
GET  /api/gpu/command-status   — check result of a sent command
GET  /api/gpu/node-logs        — get recent Docker logs from node

# ═══ Compute Jobs (Demand Side — VIP) ═══
GET  /api/compute/markets      — list available Nosana GPU markets + pricing
POST /api/compute/submit       — submit Docker job to Nosana (SOL → NOS swap)
POST /api/compute/deploy       — create persistent deployment (always-on service)
GET  /api/compute/status/:id   — get job status from Nosana + Redis
GET  /api/compute/jobs         — user's job history
GET  /api/compute/swap-quote   — preview SOL → NOS swap quote (Jupiter v6)
GET  /api/compute/summary      — compute usage summary

# ═══ Premium Alpha Tools (Demand Side) ═══
GET  /api/premium/features     — list all 9 premium GPU features + pricing
POST /api/premium/execute      — run a premium feature (pays SOL, burns NOS)
GET  /api/premium/result/:id   — get feature result (polls Nosana for status)
GET  /api/premium/history      — user's premium job history
GET  /api/premium/stats        — global NOS burn stats, feature usage counts
```

---

*See also: [GPU & Nosana Guide](GPU_NOSANA_GUIDE.md) for full setup instructions.*
