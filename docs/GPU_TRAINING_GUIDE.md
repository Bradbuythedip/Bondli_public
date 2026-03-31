# Bondli GPU Training Guide

Run your GPU to train and serve Bondli's LoRA scoring model. Earn $NOS while improving the network.

---

## Requirements

- **GPU**: NVIDIA with 8GB+ VRAM (RTX 3060+, RTX 4060+, RTX 5070 Ti recommended)
- **NVIDIA Driver**: 535+ with CUDA 12.1+
- **Python**: 3.10+
- **Docker**: Required for Nosana node (earnings)
- **OS**: Ubuntu 22.04+ / Windows WSL2 / macOS (CPU-only)

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/Bradbuythedip/bondli.git
cd bondli

# 2. Install Python dependencies
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
pip install fastapi uvicorn pydantic redis

# 3. Train the model (generates checkpoints)
python src/ml/train.py --epochs 50

# 4. Start the inference server
python src/ml/serve.py --device cuda

# 5. Verify it's running
curl http://localhost:8420/health
```

---

## Architecture

```
Your GPU runs two things:

┌─────────────────────────────────────────────────────┐
│  1. LoRA Training    (src/ml/train.py)              │
│     - Pulls trade outcome data                      │
│     - Trains transformer model with LoRA adapters   │
│     - Outputs checkpoint files (~500KB)             │
│                                                     │
│  2. Inference Server (src/ml/serve.py)              │
│     - Loads trained model onto GPU                  │
│     - Serves predictions via HTTP (port 8420)       │
│     - <2ms per token on RTX 5070 Ti                 │
│     - Bondli backend calls this for every token     │
└─────────────────────────────────────────────────────┘
```

### Model Specs

| Spec | Value |
|------|-------|
| Architecture | Transformer encoder + 3 prediction heads |
| Input | 115-dim feature vector (40+ ML features, padded) |
| Layers | 4 transformer layers, 8 attention heads |
| LoRA rank | 16 (Q/V projections only) |
| Total params | ~2M |
| Trainable params | ~50K (LoRA only — 2.5% of total) |
| Output | Score (0-100), Rug probability (0-1), Graduation probability (0-1) |
| Checkpoint size | ~500KB (LoRA weights only) |
| Inference speed | <2ms/token (CUDA), ~10ms/token (CPU) |

---

## Training

### From Redis (Live Data)

If you're running the full Bondli backend with Redis, training pulls directly from the live trade outcome stream:

```bash
# Default: 50 epochs, lr=3e-4, batch=32
python src/ml/train.py

# Custom hyperparameters
python src/ml/train.py \
  --epochs 100 \
  --lr 3e-4 \
  --batch-size 32 \
  --lora-rank 16

# Full fine-tune (all 2M params, not just LoRA)
python src/ml/train.py --full-finetune --lr 1e-4 --epochs 200
```

### From JSON (Offline Batch)

Export training data from Bondli and train offline:

```bash
python src/ml/train.py --from-json training_data.json
```

### Feature Groups (67 features across 11 categories)

| Group | Prefix | Count | What it measures |
|-------|--------|-------|------------------|
| Tipping Point | `tp_` | 6 | Law of Few, Stickiness, Context, Connector/Maven/Salesman |
| Kahneman | `k_` | 6 | Cognitive Ease, Emotional Valence, Herd Signal, Loss Aversion |
| On-Chain | `oc_` | 11 | Buy velocity, Unique buyers, Volume, Dev hold %, Mcap |
| Social | `so_` | 7 | Twitter/Telegram/Website presence, Name quality |
| Rug Detection | `rg_` | 17 | Dev sell speed, Coordinated dumps, Fake volume, Wash trading |
| Chart Patterns | `ch_` | 5 | Health score, Pump-dump, Staircase, Dip ratio |
| Cascade | `cs_` | 5 | Cascade onset/strength, Reflexivity, Curve velocity |
| Viral (SIR) | `sir_` | 3 | R0, Infection rate, Recovery rate |
| Grad Frontrun | `gf_` | 2 | Curve progress, Frontrun signal |
| Attn-Price Diverge | `apd_` | 3 | Attention growth, Price flatness, Divergence |
| Timing | `mt_` | 3 | Hour of day, Day of week, Is weekend |

Input vector is padded to 115 dimensions for forward compatibility.

### Loss Weights

| Head | Loss | Weight | Why |
|------|------|--------|-----|
| Score | MSE | 1.0x | Regression target |
| Rug | BCE | 3.0x | Missing a rug costs money — rug detection is critical |
| Graduation | BCE | 1.5x | Catching graduates = profit |

### Output Files

```
src/ml/checkpoints/
├── bondli_scorer_latest.pt   # Full model (all weights)
├── bondli_lora_latest.pt     # LoRA weights only (~500KB)
└── bondli_scorer_best.pt     # Best validation checkpoint
```

---

## Inference Server

```bash
# Start on GPU
python src/ml/serve.py --device cuda --port 8420

# CPU fallback
python src/ml/serve.py --device cpu --port 8420
```

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/predict` | POST | Score one token: `{"features": {...}}` → `{"score": 72, "rugProb": 0.12, "graduationProb": 0.45}` |
| `/predict/batch` | POST | Score up to 100 tokens at once |
| `/health` | GET | Model status, GPU info, VRAM usage, benchmark speed |
| `/reload` | POST | Hot-reload weights from disk (no restart needed) |

### Connect to Bondli Backend

Set the environment variable so the Node.js backend finds your server:

```bash
export BONDLI_LORA_URL=http://127.0.0.1:8420
```

The backend's `lora-client.mjs` will automatically:
- Health-check every 30s
- Blend LoRA predictions with rule-based scores (40% LoRA / 60% rules)
- Fall back to rules-only if your server is down (zero downtime)
- Override rule-based scores when LoRA detects rugs with >90% confidence

---

## GPU Earnings (Nosana)

While your GPU serves inference, it can also earn $NOS by running Nosana compute jobs.

### Setup

1. **Register your node** on the Bondli GPU tab (connect wallet first)
2. **Install the Nosana agent**:
   ```bash
   # Install Docker if you haven't
   curl -fsSL https://get.docker.com | sh

   # Pull and run the Nosana node
   docker run -d \
     --name bondli-nosana \
     --gpus all \
     -v ~/.nosana:/root/.nosana \
     -e NOSANA_MARKET=<your-market-id> \
     nosana/nosana-node:latest
   ```
3. **Copy your node keypair** from the Bondli dashboard to `~/.nosana/nosana_key.json`
4. The agent sends heartbeats every 60s — Bondli tracks your uptime and earnings

### Earnings Split

| Tier | Your Cut | Platform Fee |
|------|----------|--------------|
| Pro | 95% | 5% |
| Free | 90% | 10% |

Earnings are swept hourly on-chain. Minimum sweep: 1 NOS.

### Node Commands (Remote via Dashboard)

- **Restart Node** — restarts the Docker container
- **Stop Node** — gracefully stops the agent
- **View Logs** — last 50 lines of Docker logs
- **GPU Details** — power draw, fan speed, clocks, driver version
- **Set Power Limit** — adjust TDP remotely (50-500W)

---

## Full Offline Workflow

For users who want to contribute training compute without running the full backend:

```bash
# 1. Get training data (exported from Bondli)
wget https://bondli.fun/api/training-export -O training_data.json

# 2. Train locally
python src/ml/train.py \
  --from-json training_data.json \
  --epochs 100 \
  --lr 3e-4 \
  --batch-size 32

# 3. Upload your LoRA weights back
# (The checkpoint is only ~500KB)
curl -X POST https://bondli.fun/api/gpu/upload-weights \
  -F "weights=@src/ml/checkpoints/bondli_lora_latest.pt" \
  -H "Authorization: Bearer <your-wallet-signature>"

# 4. Or serve locally and point the backend at your GPU
python src/ml/serve.py --device cuda
export BONDLI_LORA_URL=http://<your-ip>:8420
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `CUDA out of memory` | Reduce `--batch-size` to 16 or 8 |
| `No CUDA device` | Install NVIDIA drivers + CUDA toolkit: `nvidia-smi` should work |
| Server shows "offline" in Intel | Check `curl http://localhost:8420/health` — model may not be loaded |
| LoRA not blending | Backend needs `BONDLI_LORA_URL` env var set |
| Training stuck at 0% | Check Redis connection or use `--from-json` instead |
| Node shows "connected" after disconnect | Fixed: timeout reduced to 90s (was 5 min) |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BONDLI_LORA_URL` | `http://127.0.0.1:8420` | Inference server URL |
| `REDIS_URL` | `redis://localhost:6379` | Redis for training data |
| `CUDA_VISIBLE_DEVICES` | `0` | Which GPU to use |

---

## Contributing Compute

Every GPU that trains and serves the LoRA model makes the entire network smarter. The model learns from real trade outcomes — the more data and compute, the better the scoring. Your GPU earns $NOS while making everyone's trades more accurate.
