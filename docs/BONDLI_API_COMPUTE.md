# Bondli API — Compute Job Endpoints

Submit custom Docker containers to the Nosana GPU marketplace. VIP tier required.

Base URL: `https://bondli.fun`

---

## Endpoints

### GET /api/compute/markets

List available Nosana GPU markets with pricing.

**Response (200):**
```json
{
  "markets": [
    {
      "tier": "RTX 3060",
      "address": "7AtiXMSH6R1jjBxrcYjehCkkSF7zvYWte63gwEDBcGHq",
      "nosPerSec": 0.000043,
      "vram": 12,
      "estimatedCostSol": 0.005
    },
    {
      "tier": "RTX 4090",
      "address": "97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf",
      "nosPerSec": 0.000097,
      "vram": 24,
      "estimatedCostSol": 0.012
    },
    {
      "tier": "H100",
      "address": "Crop49jpc7prcgAcS82WbWyGHwbN5GgDym3uFbxxCTZg",
      "nosPerSec": 0.000150,
      "vram": 80,
      "estimatedCostSol": 0.025
    }
  ]
}
```

---

### POST /api/compute/submit

Submit a Docker job to Nosana. SOL is swapped to NOS via Jupiter v6 automatically.

**Headers:** `X-Wallet`

**Request:**
```json
{
  "market": "RTX 4090",
  "docker": {
    "image": "your-image:latest",
    "cmd": ["python", "run.py"],
    "env": {"KEY": "value"}
  },
  "template": null
}
```

Quick-select templates: `"scorer"`, `"ollama"`, `"vllm"`

**Response (200):**
```json
{
  "jobId": "compute_abc123",
  "status": "submitted",
  "market": "RTX 4090",
  "costSol": 0.012,
  "nosSwapped": 1.45,
  "txSignature": "5abc...swap_tx"
}
```

---

### POST /api/compute/deploy

Create a persistent always-on deployment (long-running service).

**Headers:** `X-Wallet`

**Request:**
```json
{
  "market": "RTX 4090",
  "docker": {
    "image": "your-service:latest",
    "ports": [8080]
  },
  "healthCheck": {
    "path": "/health",
    "interval": 60
  }
}
```

**Response (200):**
```json
{
  "deployId": "deploy_xyz",
  "status": "starting",
  "market": "RTX 4090"
}
```

---

### GET /api/compute/status/:id

Get job status from Nosana + Redis.

**Response (200):**
```json
{
  "jobId": "compute_abc123",
  "status": "completed",
  "result": { },
  "duration": 45.2,
  "nosUsed": 1.45
}
```

Statuses: `submitted`, `queued`, `running`, `completed`, `failed`

---

### GET /api/compute/jobs

User's job history.

**Headers:** `X-Wallet`

**Response (200):**
```json
{
  "jobs": [
    {
      "jobId": "compute_abc123",
      "market": "RTX 4090",
      "status": "completed",
      "costSol": 0.012,
      "submittedAt": "2026-03-24T12:00:00Z"
    }
  ]
}
```

---

### GET /api/compute/swap-quote

Preview SOL → NOS swap quote via Jupiter v6.

**Query:** `?amountSol=0.01`

**Response (200):**
```json
{
  "inputSol": 0.01,
  "outputNos": 1.21,
  "priceImpact": 0.001,
  "route": "Jupiter v6"
}
```

---

### GET /api/compute/summary

Compute usage summary for the user.

**Headers:** `X-Wallet`

**Response (200):**
```json
{
  "totalJobs": 15,
  "totalSolSpent": 0.18,
  "totalNosBurned": 21.8,
  "activeDeployments": 0
}
```

---

### Pricing

- 15% Bondli margin on all compute jobs
- SOL → NOS swap via Jupiter v6 (1% slippage tolerance)
- Job costs vary by GPU tier and duration

---

*See also: [Full API Reference](BONDLI_API.md)*
