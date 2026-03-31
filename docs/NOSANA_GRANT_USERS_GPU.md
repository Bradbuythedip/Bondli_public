# Nosana Grant — End User Profile: GPU Owners

## Who they are

Individuals with NVIDIA GPUs (RTX 3060 through A100/H100) sitting idle or underutilized. Many are former crypto miners whose hardware became unprofitable after Ethereum's merge to proof-of-stake. Others are gamers, AI hobbyists, or small-scale ML practitioners with powerful GPUs that run at <10% utilization most of the day. They range from a single desktop with an RTX 4070 to small operations with 3-5 racked GPUs.

## Their needs

1. **Passive income from hardware they already own.** These users spent $500-$15,000 on GPUs. They want those GPUs earning money when not in active use. They've heard of DePIN networks but the setup friction — Docker, Solana wallets, keypair management, market selection, container orchestration — stops most of them cold.

2. **Simple setup and monitoring.** They don't want to learn DevOps. They want to paste one command, see a dashboard showing earnings, and check on it from their phone.

3. **Transparency and trust.** They need to verify their earnings are real, on-chain, and actually arriving in their wallet. They need to trust that the platform holding their node keypair isn't stealing from them.

4. **Remote control.** Their GPU might be in a closet, a spare room, or a different location entirely. They need to restart nodes, check logs, adjust power settings, and monitor temperatures without physical access.

## How Bondli fulfills these needs

- **1-command setup:** `curl -s https://bondli.fun/gpu-agent.sh | bash -s -- --wallet <WALLET>` — auto-detects GPU, installs Docker + NVIDIA toolkit, selects Nosana market, generates keypair, starts node. Total time: ~5 minutes, zero DevOps knowledge required.

- **Web dashboard:** Real-time earnings (total NOS, pending, jobs completed), GPU metrics (temperature, fan speed, clock rates, power draw), and node status — all accessible from any browser.

- **On-chain transparency:** Every NOS sweep is a Solana transaction visible on any explorer. Users see 90-95% of earnings arrive in their wallet hourly. The 5-10% treasury cut is stated upfront and verifiable.

- **Remote commands via heartbeat:** Restart node, stop node, view logs, check GPU details, adjust power limits — all from the web dashboard, executed within 60 seconds via the heartbeat polling mechanism.
