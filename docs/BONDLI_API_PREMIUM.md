# Bondli API — Premium Alpha Tool Endpoints

Pay-per-use GPU-powered tools. Each use burns $NOS on Nosana's network.

Base URL: `https://bondli.fun`

---

## Endpoints

### GET /api/premium/features

List all 9 premium GPU features with pricing.

**Response (200):**
```json
{
  "features": [
    {
      "id": "deep_rug_scan",
      "name": "Deep Rug Scanner",
      "priceSol": 0.005,
      "category": "scan",
      "description": "Forensic token analysis — on-chain + social + code decompilation"
    },
    {
      "id": "entry_simulator",
      "name": "Entry Simulator",
      "priceSol": 0.01,
      "category": "simulate",
      "description": "Monte Carlo entry timing with 5,000 path simulations"
    },
    {
      "id": "wallet_xray",
      "name": "Wallet X-Ray",
      "priceSol": 0.008,
      "category": "scan",
      "description": "Deep-profile any wallet — 90-day history, cluster analysis"
    },
    {
      "id": "exit_timing",
      "name": "Exit Timing AI",
      "priceSol": 0.005,
      "category": "simulate",
      "description": "Optimal exit path modeling with 5,000 simulations"
    },
    {
      "id": "launch_simulator",
      "name": "Launch Simulator",
      "priceSol": 0.02,
      "category": "simulate",
      "description": "Pre-launch 10K scenario simulation"
    },
    {
      "id": "mev_protection",
      "name": "MEV Protection",
      "priceSol": 0.01,
      "category": "protect",
      "description": "Sandwich bot detection and trade protection"
    },
    {
      "id": "portfolio_rebalancer",
      "name": "Portfolio Rebalancer",
      "priceSol": 0.02,
      "category": "optimize",
      "description": "AI-optimized position rebalancing"
    },
    {
      "id": "custom_lora",
      "name": "Custom LoRA Model",
      "priceSol": 0.1,
      "category": "subscribe",
      "billingCycle": "weekly",
      "description": "Train on your own trade history — personal scoring model"
    },
    {
      "id": "chart_pattern_cnn",
      "name": "Chart Pattern CNN",
      "priceSol": 0.05,
      "category": "subscribe",
      "billingCycle": "weekly",
      "description": "AI pattern recognition: accumulation, distribution, breakout, trap, divergence"
    }
  ]
}
```

---

### POST /api/premium/execute

Run a premium feature. User pays SOL, Bondli swaps to NOS, GPU job submitted.

**Headers:** `X-Wallet`

**Request:**
```json
{
  "featureId": "deep_rug_scan",
  "params": {
    "ca": "pump123...abc"
  }
}
```

**Response (200):**
```json
{
  "jobId": "premium_abc123",
  "feature": "deep_rug_scan",
  "status": "submitted",
  "costSol": 0.005,
  "nosBurned": 0.61,
  "estimatedDuration": 30
}
```

Results are also delivered via WebSocket in real-time.

---

### GET /api/premium/result/:id

Get feature result. Polls Nosana for job status.

**Response (200):**
```json
{
  "jobId": "premium_abc123",
  "feature": "deep_rug_scan",
  "status": "completed",
  "result": {
    "riskScore": 0.15,
    "signals": [],
    "devProfile": {
      "tokensLaunched": 3,
      "rugCount": 0,
      "trustScore": 0.88
    },
    "artworkOriginal": true,
    "socialPresent": true
  },
  "duration": 22.4
}
```

Statuses: `submitted`, `running`, `completed`, `failed`

---

### GET /api/premium/history

User's premium job history.

**Headers:** `X-Wallet`

**Response (200):**
```json
{
  "jobs": [
    {
      "jobId": "premium_abc123",
      "feature": "deep_rug_scan",
      "status": "completed",
      "costSol": 0.005,
      "nosBurned": 0.61,
      "createdAt": "2026-03-24T12:00:00Z"
    }
  ]
}
```

---

### GET /api/premium/stats

Global NOS burn stats and feature usage counts.

**Response (200):**
```json
{
  "totalNosBurned": 456.78,
  "totalRevenueSol": 12.34,
  "featureUsage": {
    "deep_rug_scan": 1234,
    "entry_simulator": 567,
    "wallet_xray": 890,
    "exit_timing": 345,
    "launch_simulator": 123,
    "mev_protection": 234,
    "portfolio_rebalancer": 56,
    "custom_lora": 12,
    "chart_pattern_cnn": 34
  }
}
```

---

### Pricing & Margins

- 25% Bondli margin on all premium features
- SOL → NOS swap via Jupiter v6 (1% slippage)
- Deep Rug Scan available as 1-click shortcut on every token card in Radar

---

*See also: [Full API Reference](BONDLI_API.md) | [Compute Jobs](BONDLI_API_COMPUTE.md)*
