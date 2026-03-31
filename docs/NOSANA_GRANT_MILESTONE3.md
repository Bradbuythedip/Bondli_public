# Nosana Grant — Milestone 3 & Priority Features

## Milestone 3: Self-Sustaining Flywheel Operational (Month 6)

**Deliverable:** The Bondli flywheel is demonstrably self-sustaining — GPU earnings fund ML compute, ML compute improves trading scores, better scores attract more traders, trading fees fund GPU fleet growth.

**What this proves:** A sustainable demand loop for Nosana compute that doesn't require ongoing subsidies. Bondli's treasury receives 5-10% of all GPU $NOS earnings. These funds partially flow back to Nosana as compute job payments for ML workloads. More traders using better ML scores generate more trading fee revenue, which funds marketing to onboard more GPU owners. Each side of the platform feeds the other.

**Metrics:**
- Monthly NOS earned vs NOS spent on compute (ratio trending toward 1:1)
- Net new GPU nodes per month (organic, not subsidized)
- Trading volume attributed to ML-scored entries
- Treasury runway without external funding

---

## 4. Product-Level Features Prioritized During Development

### Priority 1: GPU Fleet Management Dashboard (Enhances Nosana adoption)

Expand the existing GPU dashboard with fleet-wide analytics: aggregate earnings across all nodes, comparative GPU performance (NOS/hour by GPU tier), node health alerts, and remote management (restart, stop, power limit adjustment — all already functional via heartbeat commands). This is the primary touchpoint that retains GPU owners and showcases Nosana earnings.

**Already built:** Node registration, heartbeat monitoring, remote commands (restart/stop/logs/GPU details/power limit), earnings display, sweep tracking. **Next:** Fleet-wide leaderboards, earnings projections, GPU ROI calculator, uptime badges.

### Priority 2: Nosana Job Router Optimization (Drives NOS demand)

Our job router (`nosana-job-router.mjs`, 463 lines) currently routes AI inference tasks to the best available GPU based on type, VRAM, load, and pricing. Priority features: intelligent job queuing with retry logic, multi-node parallel inference for batch scoring, cost-optimized routing that prefers Bondli fleet nodes, and fallback to Nosana marketplace when fleet capacity is exhausted.

**Already built:** GPU tier mapping (12 tiers from RTX 3060 to H100), market address resolution, job submission via Nosana SDK, IPFS pinning for job definitions. **Next:** Batch inference, priority queuing, fleet-first routing, cost tracking dashboard.
