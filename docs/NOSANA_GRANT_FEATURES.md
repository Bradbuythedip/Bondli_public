# Nosana Grant — Priority Features 3-4 & Rationale

### Priority 3: ML Model Serving via Nosana Compute (Core use case)

Migrate Bondli's LoRA scorer from local/centralized inference to Nosana-hosted GPU inference. The model is lightweight (~2M params, 50K trainable via LoRA) but runs on every token launch — potentially thousands of scoring requests per hour during peak Solana activity. Serving via Nosana creates real, measurable AI compute demand and proves Nosana's viability for latency-sensitive ML workloads.

**Already built:** FastAPI model server (`src/ml/serve.py`, port 8420), LoRA model with 3 prediction heads (score, rug probability, graduation probability), online training pipeline. **Next:** Nosana-native deployment, A/B testing between local and Nosana inference, latency monitoring, automatic failover.

### Priority 4: Encrypted Node Key Management (Security hardening)

Currently, node keypairs are stored in Redis. For production scale with 50+ nodes, we need encrypted key storage (KMS/Vault integration), key rotation mechanisms, IP-pinned heartbeat verification, and audit logging for all keypair generation and NOS distributions. This is critical for trust at scale — GPU owners need confidence their earnings are secure.

**Already built:** Keypair generation, custody wallet model, hourly sweep with threshold. **Next:** AES-256 encryption at rest, HSM/KMS integration, key rotation, tamper-evident audit log.

---

## 5. Rationale: Why These Milestones and Features Will Impact Project Success

### Why these milestones matter — in sequence

The three milestones are ordered as a dependency chain, not arbitrary targets. Each one unlocks the next.

**Milestone 1 (50 nodes) is the supply foundation.** Without a critical mass of GPU nodes, there's no fleet to route inference jobs to, no NOS earnings to demonstrate ROI, and no proof that Bondli's 1-command onboarding actually converts GPU owners. 50 nodes is the minimum viable fleet — enough to handle Bondli's own ML workload, demonstrate earnings consistency across GPU tiers, and produce real data for the dashboard.

**Milestone 2 (ML on Nosana) converts supply into demand.** A GPU fleet earning NOS from general Nosana marketplace jobs is useful but doesn't differentiate Bondli. Running our own ML inference on Nosana nodes creates *captive demand* — Bondli becomes both a supply aggregator and a compute consumer. Solana launches 10,000+ tokens per day. Scoring each one across 40+ features means thousands of inference requests daily — not synthetic load, but real decisions driving real trades with real money.

**Milestone 3 (flywheel) proves sustainability.** Grant-funded growth that collapses without continued funding isn't interesting. The flywheel milestone demonstrates that Bondli's two-sided model generates enough revenue (GPU treasury cut + trading fees) to fund its own compute costs and continued GPU onboarding.

### Why these features matter — for Nosana specifically

Every prioritized feature directly increases Nosana network utilization:

- **GPU Dashboard** retains node operators. Churn is the death of DePIN networks.
- **Job Router** maximizes fleet utilization. Idle nodes earn nothing and their operators leave.
- **ML on Nosana** creates the demand side. Bondli solves the chicken-and-egg by being its own first customer.
- **Encrypted Key Management** unlocks institutional-grade trust for GPU owners committing expensive hardware.

### What failure looks like (and how milestones catch it early)

If we can't reach 50 nodes by Month 2, it means the onboarding UX isn't good enough or GPU owners don't find the earnings compelling — and we pivot before spending the ML infrastructure budget. If ML inference on Nosana exceeds acceptable latency at Month 4, we know before committing to full migration. Each milestone is a decision gate, not just a checkbox.
