# Bondli — Quick Start & Configuration

## Quick Start

```bash
# Clone and install
git clone https://github.com/Bradbuythedip/bondli.git
cd bondli
npm run setup

# Configure
cp .env.example .env
# Edit .env with your ALCHEMY_API_KEY, MASTER_SEED, etc.

# Development (frontend + backend)
npm run dev

# Production
npm run build
npm start

# GPU earning (on a machine with NVIDIA GPU)
curl -s https://bondli.fun/gpu-agent.sh | bash -s -- --wallet <YOUR_WALLET>
```

### Production Deployment (Docker)

```bash
# First time
./deploy/deploy.sh fresh

# Update
./deploy/deploy.sh update

# Status & logs
./deploy/deploy.sh status
./deploy/deploy.sh logs
```

---

## Environment Variables

```bash
# ═══ Required ═══
ALCHEMY_API_KEY=             # Alchemy RPC (free tier: 100M compute units/mo)
MASTER_SEED=                 # Trading wallet master seed (base58)
API_PORT=3001                # Server port
REDIS_URL=                   # Redis connection string (redis://localhost:6379)

# ═══ Optional — Trading ═══
RPC_URL=                     # Custom RPC (overrides Alchemy)
API_SECRET=                  # Admin API secret
PLATFORM_WALLET=             # Fee destination wallet
X_BEARER_TOKEN=              # Twitter/X API bearer token
BONDLI_LORA_URL=             # LoRA scoring server (http://127.0.0.1:8420)

# ═══ Optional — GPU / Nosana ═══
NOSANA_API_KEY=              # Nosana API bearer token
NOSANA_API_URL=              # Nosana API base URL
NOSANA_DEPLOY_MARKET=        # Default market for deployments
NOSANA_INFERENCE=false       # Enable/disable Nosana job routing
COMPUTE_WALLET_SECRET=       # Keypair for SOL→NOS swaps (compute engine)

# ═══ Optional — AI Chat ═══
XAI_API_KEY=                 # xAI API key for Grok 4 chat support
GROK_MODEL=                  # Model override (default: grok-4)

# ═══ Optional — Bags.fm ═══
BAGS_API_KEY=                # Bags.fm API key
BAGS_PARTNER_WALLET=         # Partner wallet for revenue sharing
```

---

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run setup` | Install all dependencies (root + app) |
| `npm run dev` | Start dev server (API + Vite frontend) |
| `npm run build` | Build frontend for production |
| `npm start` | Start production server |
| `npm run scan` | Run rug scanner standalone |
| `npm run dry` | Dry-run orchestrator |
| `npm run recover` | Check for recoverable positions |
| `npm run deploy:fresh` | Full production deployment |
| `npm run deploy:update` | Rebuild and restart |
| `npm run deploy:status` | Check service health |
| `npm run deploy:logs` | Tail API logs |
| `npm run generate:secrets` | Generate secure env values |

---

## Redis Schema

```
# ── GPU Nodes ──
bondli:gpu:node:{addr}            # Node registration + metrics
bondli:gpu:user_node:{wallet}     # User → node mapping
bondli:gpu:nodekey:{addr}         # Node keypair

# ── Compute Jobs ──
compute:job:{jobId}               # Job record (7-day TTL)
compute:user:{userId}:jobs        # User's job history (30-day TTL)
compute:deploy:{deployId}         # Deployment record

# ── Premium Alpha Tools ──
premium:job:{jobId}               # Premium job record (7-day TTL)
premium:user:{userId}:jobs        # User's premium history (30-day TTL)
premium:total_nos_burned          # Global NOS burn counter
premium:total_revenue_sol         # Global revenue counter
premium:feature_usage             # Per-feature usage hash
```
