# Bondli — Nosana Grant Application Answers

**Requested Amount: $25,000**

---

## 1. How do you plan to utilize the grant funds?

We will use the grant to scale Bondli's Nosana-powered GPU fleet and deepen our integration with the Nosana network. Bondli is already live on Solana mainnet with a working Nosana integration — nodes register, accept AI inference jobs, earn $NOS, and get swept to user wallets hourly. The grant accelerates three things: onboarding more GPU owners (subsidized setup + incentives), expanding our ML inference workloads running on Nosana compute (LoRA model training and real-time token scoring), and hardening the integration for production scale (encrypted key management, multi-GPU support, improved job routing).

Every dollar drives direct demand for $NOS — more nodes earning, more inference jobs submitted, more on-chain NOS volume.

---

## 2. Budget Overview

| Category | Amount | % | Description |
|---|---|---|---|
| **GPU Fleet Expansion** | $10,000 | 40% | Node operator onboarding incentives (NOS staking subsidies for first 50 nodes), GPU setup support, marketing to GPU owners via crypto mining communities and AI/ML Discord servers |
| **ML Infrastructure on Nosana** | $7,500 | 30% | Run Bondli's LoRA model training jobs on Nosana GPUs, expand inference capacity for real-time token scoring (currently 40+ features per token at <5ms), dataset expansion for rug detection accuracy |
| **Nosana SDK Integration & Dev** | $5,000 | 20% | Multi-GPU job routing optimization, encrypted node key management (KMS integration), heartbeat reliability improvements, Nosana SDK v2+ feature adoption, automated node health monitoring |
| **Community & Documentation** | $2,500 | 10% | GPU owner onboarding guides, video tutorials for 1-command setup, node operator support channel, Nosana ecosystem documentation contributions |
| **Total** | **$25,000** | **100%** | |

---

## 3. Three Major Milestones (Within 6 Months)

### Milestone 1: 50 Active GPU Nodes on Nosana via Bondli (Month 2)

**Deliverable:** 50 GPU owners running Nosana nodes through Bondli's 1-command installer (`curl bondli.fun/gpu-agent.sh | bash`), actively earning $NOS.

**What this proves:** Bondli is a viable aggregation and onboarding layer for Nosana. Today, setting up a Nosana node requires Docker configuration, Solana keypair management, market selection, and container orchestration. Bondli reduces this to a single command that auto-detects GPU type, selects the optimal Nosana market (RTX 3060 through H100), generates a custody keypair, and starts the node container with GPU passthrough. Reaching 50 nodes proves the UX thesis — that simplifying onboarding dramatically increases Nosana's compute supply.

**Metrics:**
- 50+ registered nodes with active heartbeats
- Cumulative $NOS earned across fleet
- Average node uptime >90%
- Support ticket volume per node (target: <1 per setup)

---

### Milestone 2: ML Inference Workloads Running on Nosana (Month 4)

**Deliverable:** Bondli's LoRA-based token scoring model (128-dim, 4-layer transformer, rank-16 adapters) running inference and periodic retraining on Nosana GPUs instead of centralized infrastructure.

**What this proves:** Real AI demand flowing through Nosana's network from an actual production application — not synthetic benchmarks. Bondli scores every new Solana token launch across 40+ ML features in <5ms. Moving this inference to Nosana nodes creates recurring, high-frequency job demand. The model retrains online from every trade outcome, requiring periodic GPU-intensive training runs that generate sustained Nosana job flow.

**Metrics:**
- Inference jobs submitted to Nosana per day
- Model training runs completed on Nosana GPUs
- Inference latency (target: <10ms via Nosana vs <5ms local)
- NOS spent on compute jobs monthly
