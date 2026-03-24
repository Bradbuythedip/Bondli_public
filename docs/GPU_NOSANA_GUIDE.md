# Bondli GPU Earnings — Nosana Integration Guide

Earn **$NOS tokens** by plugging your NVIDIA GPU into the [Nosana](https://nosana.io) decentralized compute network — all managed through Bondli.

---

## Table of Contents

- [Overview](#overview)
- [How It Works](#how-it-works)
- [Supported GPUs & Earnings Rates](#supported-gpus--earnings-rates)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [GPU Agent Lifecycle](#gpu-agent-lifecycle)
- [Earnings & Fee Sweep](#earnings--fee-sweep)
- [Dashboard & Monitoring](#dashboard--monitoring)
- [Remote Commands](#remote-commands)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)

---

## Overview

Bondli's GPU Earnings layer lets any user with a compatible NVIDIA GPU earn $NOS tokens passively. Your GPU accepts AI inference jobs from the Nosana decentralized marketplace — when jobs complete, you earn NOS that is automatically swept to your Solana wallet.

**Key principles:**

- **One command setup** — a single `curl | bash` installs everything
- **1 user = 1 GPU = 1 node** — each user runs exactly one Nosana node
- **Automatic earnings** — hourly sweep sends NOS directly to your wallet
- **Full transparency** — all transfers are on-chain and verifiable on Solana Explorer
- **No lock-in** — deregister anytime and receive your final sweep

---

## How It Works

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│  Your GPU    │────▶│  Bondli API  │────▶│  Nosana Network  │
│  (Agent)     │     │  (Orchestr.) │     │  (Job Marketplace)│
└──────────────┘     └──────────────┘     └──────────────────┘
       │                    │                       │
       │  Heartbeat (60s)   │                       │
       │───────────────────▶│                       │
       │                    │   Accept inference    │
       │                    │◀──────────────────────│
       │   Run job on GPU   │                       │
       │◀───────────────────│                       │
       │                    │                       │
       │   Job complete     │   Earn $NOS           │
       │───────────────────▶│◀──────────────────────│
       │                    │                       │
       │                    │   Hourly sweep        │
       │   NOS to wallet    │   (90-95% to user)    │
       │◀───────────────────│                       │
```

1. **Register** — Bondli generates a dedicated Solana keypair for your node
2. **Install** — The GPU agent installs Docker + NVIDIA Container Toolkit
3. **Start** — A Nosana node container launches and connects to the marketplace
4. **Earn** — Your GPU processes AI inference jobs and earns NOS tokens
5. **Sweep** — Every hour, Bondli splits earnings: 90-95% to you, 5-10% platform fee

---

## Supported GPUs & Earnings Rates

| GPU Model | VRAM | NOS/sec | Est. Daily NOS | Nosana Market Tier |
|-----------|------|---------|----------------|--------------------|
| RTX 3060 | 12 GB | 0.000043 | ~3.7 | Entry |
| RTX 3070 | 8 GB | 0.000043 | ~3.7 | Entry |
| RTX 3080 | 10 GB | 0.000065 | ~5.6 | Mid |
| RTX 3090 | 24 GB | 0.000090 | ~7.8 | High |
| RTX 4070 | 12 GB | 0.000045 | ~3.9 | Entry |
| RTX 4080 | 16 GB | 0.000075 | ~6.5 | Mid |
| RTX 4090 | 24 GB | 0.000097 | ~8.4 | High |
| RTX 5070 | 12 GB | 0.000070 | ~6.0 | Mid |
| RTX 5080 | 16 GB | 0.000090 | ~7.8 | High |
| RTX 5090 | 32 GB | 0.000120 | ~10.4 | Premium |
| A4000 | 16 GB | 0.000065 | ~5.6 | Mid |
| A5000 | 24 GB | 0.000090 | ~7.8 | High |
| A6000 | 48 GB | 0.000100 | ~8.6 | Premium |
| A100 | 80 GB | 0.000115 | ~9.9 | Data Center |
| H100 | 80 GB | 0.000150 | ~13.0 | Data Center |

> **Note:** Daily estimates assume 24h uptime with full job utilization. Laptop GPUs are not currently supported.

---

## Quick Start

### Prerequisites

- **Desktop NVIDIA GPU** (see supported list above)
- **Linux** (Ubuntu 20.04+ recommended) or WSL2 on Windows
- **NVIDIA drivers** installed (`nvidia-smi` must work)
- **Solana wallet** address to receive earnings

### One-Line Setup

```bash
curl -s https://bondli.fun/gpu-agent.sh | bash -s -- --wallet <YOUR_SOLANA_WALLET>
```

This single command:

1. Detects your NVIDIA GPU model and VRAM
2. Installs Docker and NVIDIA Container Toolkit (if missing)
3. Registers your node with Bondli (`POST /api/gpu/register`)
4. Writes the generated Solana keypair to `~/.nosana/nosana_key.json`
5. Starts the Nosana node Docker container
6. Launches a heartbeat daemon reporting metrics every 60 seconds
7. Your GPU begins accepting inference jobs immediately

### Verify It's Running

```bash
# Check the Nosana node container
docker ps | grep nosana

# Check GPU utilization
nvidia-smi

# View node logs
docker logs nosana-node --tail 50
```

Or visit the **GPU tab** in the Bondli dashboard at [bondli.fun](https://bondli.fun).

---

## Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────┐
│                   User's Machine                     │
│                                                      │
│  ┌────────────────┐    ┌──────────────────────────┐  │
│  │  GPU Agent      │    │  Nosana Node (Docker)    │  │
│  │  (bash daemon)  │    │                          │  │
│  │                 │    │  - Accepts jobs from      │  │
│  │  - Heartbeat    │    │    Nosana marketplace     │  │
│  │  - Metrics      │    │  - Runs AI inference      │  │
│  │  - Commands     │    │  - Reports completion     │  │
│  └────────┬───────┘    └──────────────────────────┘  │
│           │                                          │
└───────────┼──────────────────────────────────────────┘
            │ HTTPS (every 60s)
            ▼
┌─────────────────────────────────────────────────────┐
│                  Bondli API Server                    │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ gpu-earnings  │  │ nosana-client│  │ job-router │  │
│  │              │  │              │  │            │  │
│  │ - Register   │  │ - Market     │  │ - Route    │  │
│  │ - Heartbeat  │  │   resolution │  │   inference│  │
│  │ - Sweep      │  │ - SDK wrapper│  │ - Health   │  │
│  │ - Dashboard  │  │ - Rate tiers │  │   checks   │  │
│  └──────────────┘  └──────────────┘  └────────────┘  │
│                                                      │
│  ┌──────────────────────────────────────────┐        │
│  │           Hourly Sweep Cron               │        │
│  │  - Check NOS balance on node ATA          │        │
│  │  - Split: user% → wallet, platform% → tx  │        │
│  │  - Min sweep: 1 NOS                       │        │
│  └──────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────┐
│              Nosana Decentralized Network             │
│                                                      │
│  - GPU marketplace with market tiers                 │
│  - AI inference job distribution                     │
│  - On-chain $NOS token rewards                       │
│  - Solana-based settlement                           │
└─────────────────────────────────────────────────────┘
```

### Key Design Decisions

- **1:1 mapping** — Each user gets exactly one Nosana node with a unique Solana keypair (Nosana network requirement)
- **Custodial keypair** — Bondli generates and manages the node keypair to enable automatic fee sweeps
- **Heartbeat-driven** — The agent reports GPU metrics every 60s; the server returns any queued commands
- **Hourly sweep** — NOS earnings are split and transferred on-chain every hour (minimum 1 NOS)

---

## GPU Agent Lifecycle

### Registration

```
POST /api/gpu/register
```

The agent sends the user's wallet address and detected GPU model. Bondli:

1. Checks no existing active node for this wallet (enforces 1:1)
2. Generates a new Solana keypair
3. Resolves the GPU to a Nosana market tier
4. Stores node metadata in Redis
5. Returns the keypair + configuration to the agent

### Heartbeat Loop

Every 60 seconds, the agent sends:

```json
{
  "wallet": "<user-wallet>",
  "nodeId": "<node-id>",
  "metrics": {
    "gpu_utilization": 85,
    "gpu_temp": 72,
    "gpu_memory_used": 8192,
    "gpu_memory_total": 12288,
    "power_draw": 180,
    "fan_speed": 65,
    "clock_speed": 1800
  },
  "status": "busy"
}
```

The server responds with any queued commands (restart, power limit changes, etc.).

### Deregistration

```
POST /api/gpu/deregister
```

Triggers a final earnings sweep, stops the node, and cleans up all state.

---

## Earnings & Fee Sweep

### How Sweeps Work

Every hour, a cron job runs across all active nodes:

1. **Check balance** — Query the node keypair's NOS Associated Token Account (ATA)
2. **Minimum threshold** — Skip if balance < 1 NOS
3. **Calculate split:**
   - **Free tier:** 85% to user wallet, 15% to Bondli treasury
   - **VIP tier:** 95% to user wallet, 5% to Bondli treasury
4. **Execute transfers** — Two Solana SPL token transfers (user + treasury)
5. **Log** — Record transaction signatures for earnings history

### Fee Tiers

| Tier | User Share | Platform Fee | How to Unlock |
|------|-----------|-------------|---------------|
| Free | 85% | 15% | Default — no payment required |
| VIP | 95% | 5% | One-time 10 SOL payment |

### Verifying Earnings

All sweep transactions are standard Solana SPL token transfers. You can verify any sweep on:

- [Solana Explorer](https://explorer.solana.com)
- [Solscan](https://solscan.io)

The Bondli dashboard shows your complete earnings history with transaction signatures.

---

## Dashboard & Monitoring

The **GPU tab** in the Bondli app at [bondli.fun](https://bondli.fun) shows:

- **Node Status** — Online / Busy / Idle / Offline
- **Real-time Metrics** — GPU utilization, temperature, memory, power draw
- **Earnings History** — NOS earned over time with transaction links
- **Total Earnings** — Cumulative NOS earned
- **Fleet View** — Aggregate view if managing multiple nodes (future)

---

## Remote Commands

You can send commands to your GPU node from the Bondli dashboard:

| Command | Description |
|---------|-------------|
| `restart` | Restart the Nosana node container |
| `stop` | Stop the node (triggers final sweep) |
| `logs` | Retrieve recent Docker logs |
| `power` | Adjust GPU power limit |

Commands are queued and delivered to the agent on the next heartbeat (within 60s).

---

## API Reference

All GPU endpoints require the `X-Wallet` header with your Solana wallet address.

### Register Node

```
POST /api/gpu/register
```

**Headers:**
```
X-Wallet: <your-solana-wallet>
```

**Request Body:**
```json
{
  "wallet": "8xYz...your_wallet",
  "gpuModel": "NVIDIA GeForce RTX 4090"
}
```

**Response (200):**
```json
{
  "nodeId": "gpu_abc123",
  "keypair": [/* 64-byte Solana keypair as JSON array */],
  "market": {
    "address": "97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf",
    "tier": "RTX 4090",
    "nosPerSec": 0.000097,
    "vram": 24
  },
  "config": {
    "heartbeatInterval": 60,
    "sweepInterval": 3600
  }
}
```

**Error (409):** User already has an active node.

---

### Reconnect Node

```
POST /api/gpu/reconnect
```

Reactivates a previously disconnected node. Preserves the original keypair (on-chain identity).

**Request Body:**
```json
{
  "wallet": "8xYz...your_wallet",
  "nodeId": "gpu_abc123"
}
```

**Response (200):**
```json
{
  "nodeId": "gpu_abc123",
  "keypair": [/* preserved keypair */],
  "status": "reconnected"
}
```

---

### Deregister Node

```
POST /api/gpu/deregister
```

Stops the node and triggers a final earnings sweep.

**Request Body:**
```json
{
  "wallet": "8xYz...your_wallet",
  "nodeId": "gpu_abc123"
}
```

**Response (200):**
```json
{
  "status": "deregistered",
  "finalSweep": {
    "amount": 2.45,
    "txSignature": "5xYz..."
  }
}
```

---

### Heartbeat

```
POST /api/gpu/heartbeat
```

Agent sends GPU metrics every 60 seconds.

**Request Body:**
```json
{
  "wallet": "8xYz...your_wallet",
  "nodeId": "gpu_abc123",
  "metrics": {
    "gpu_utilization": 85,
    "gpu_temp": 72,
    "gpu_memory_used": 8192,
    "gpu_memory_total": 12288,
    "power_draw": 180,
    "fan_speed": 65,
    "clock_speed": 1800
  },
  "status": "busy"
}
```

**Response (200):**
```json
{
  "ack": true,
  "commands": []
}
```

If commands are queued, they appear in the `commands` array:
```json
{
  "ack": true,
  "commands": [
    { "type": "restart", "id": "cmd_xyz" }
  ]
}
```

---

### Job Completed

```
POST /api/gpu/job-completed
```

Agent reports a finished Nosana inference job.

**Request Body:**
```json
{
  "wallet": "8xYz...your_wallet",
  "nodeId": "gpu_abc123",
  "jobId": "nosana_job_456",
  "duration": 45.2,
  "success": true
}
```

---

### Dashboard

```
GET /api/gpu/dashboard
```

**Headers:**
```
X-Wallet: <your-solana-wallet>
```

**Response (200):**
```json
{
  "node": {
    "nodeId": "gpu_abc123",
    "status": "busy",
    "gpuModel": "NVIDIA GeForce RTX 4090",
    "uptime": 86400,
    "lastHeartbeat": "2026-03-24T12:00:00Z",
    "metrics": {
      "gpu_utilization": 85,
      "gpu_temp": 72,
      "gpu_memory_used": 8192,
      "gpu_memory_total": 24576,
      "power_draw": 320
    }
  },
  "earnings": {
    "totalNOS": 156.78,
    "todayNOS": 8.4,
    "lastSweep": "2026-03-24T11:00:00Z",
    "pendingNOS": 1.2,
    "history": [
      {
        "amount": 7.1,
        "txSignature": "4abc...def",
        "timestamp": "2026-03-24T10:00:00Z"
      }
    ]
  },
  "market": {
    "tier": "RTX 4090",
    "nosPerSec": 0.000097
  }
}
```

---

### Fleet Overview

```
GET /api/gpu/fleet
```

Aggregate view across all nodes (for multi-node operators).

**Response (200):**
```json
{
  "totalNodes": 1,
  "activeNodes": 1,
  "totalEarningsNOS": 156.78,
  "nodes": [/* array of node summaries */]
}
```

---

### Send Command

```
POST /api/gpu/command
```

**Request Body:**
```json
{
  "wallet": "8xYz...your_wallet",
  "nodeId": "gpu_abc123",
  "command": "restart"
}
```

**Response (200):**
```json
{
  "commandId": "cmd_xyz",
  "status": "queued"
}
```

---

### Command Status

```
GET /api/gpu/command-status?commandId=cmd_xyz
```

**Response (200):**
```json
{
  "commandId": "cmd_xyz",
  "status": "completed",
  "result": "Node restarted successfully"
}
```

---

### Node Logs

```
GET /api/gpu/node-logs
```

**Headers:**
```
X-Wallet: <your-solana-wallet>
```

**Response (200):**
```json
{
  "logs": "[2026-03-24 12:00:01] Node started...\n[2026-03-24 12:00:05] Connected to market..."
}
```

---

## Troubleshooting

### Node Shows "Offline"

1. Check if the Docker container is running:
   ```bash
   docker ps | grep nosana
   ```
2. If not running, restart it:
   ```bash
   docker restart nosana-node
   ```
3. Check container logs:
   ```bash
   docker logs nosana-node --tail 100
   ```
4. Verify GPU is accessible:
   ```bash
   nvidia-smi
   ```

### No Earnings Showing

- Earnings sweep runs **hourly** with a **minimum of 1 NOS**
- If your node just started, wait at least 1-2 hours for the first sweep
- Check that your node status shows "busy" (processing jobs) not just "idle"
- Verify on [Solscan](https://solscan.io) that NOS transfers are reaching your wallet

### GPU Not Detected

```bash
# Verify NVIDIA drivers
nvidia-smi

# If not found, install drivers
sudo apt install nvidia-driver-535
sudo reboot

# Verify NVIDIA Container Toolkit
docker run --rm --gpus all nvidia/cuda:12.0-base nvidia-smi
```

### Docker Permission Issues

```bash
# Add your user to the docker group
sudo usermod -aG docker $USER
newgrp docker
```

### Reconnecting After Disconnect

If your machine rebooted or lost connection:

```bash
# Re-run the agent — it will detect existing registration and reconnect
curl -s https://bondli.fun/gpu-agent.sh | bash -s -- --wallet <YOUR_WALLET>
```

Your original keypair is preserved, so your on-chain identity and pending earnings are safe.

---

## FAQ

**Q: How much can I earn?**
A: Depends on your GPU and job availability. An RTX 4090 earns approximately 8-10 NOS/day at full utilization. Check the [earnings table](#supported-gpus--earnings-rates) for your GPU.

**Q: Do I need to keep my computer on 24/7?**
A: For maximum earnings, yes. But you can run your node whenever convenient — earnings are proportional to uptime.

**Q: Can I use my GPU for other things while earning?**
A: When a Nosana inference job is running, it uses your GPU. Between jobs, your GPU is free. Gaming while earning is possible but may reduce job throughput.

**Q: What's the minimum payout?**
A: 1 NOS per sweep (hourly). Balances below 1 NOS roll over to the next sweep.

**Q: Can I run multiple GPUs?**
A: Currently limited to 1 GPU per user wallet. Multi-GPU support is on the roadmap.

**Q: Is my private key safe?**
A: The node keypair is generated by Bondli and stored on the server for automated sweeps. This is a dedicated node keypair — not your personal wallet key. Your personal wallet private key is never shared with Bondli.

**Q: What happens if Nosana has no jobs?**
A: Your node stays idle and ready. No jobs = no earnings for that period, but no cost either.

**Q: How do I stop earning?**
A: Run deregister via the dashboard or API. A final sweep sends any remaining NOS to your wallet.
