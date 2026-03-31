# GPU Nosana Guide — Updated Fee Tiers

> **Note:** This updates the fee schedule in [GPU_NOSANA_GUIDE.md](GPU_NOSANA_GUIDE.md) to match the latest Bondli platform.

## Earnings & Fee Sweep

### How Sweeps Work

Every hour, a cron job runs across all active nodes:

1. **Check balance** — Query the node keypair's NOS Associated Token Account (ATA)
2. **Minimum threshold** — Skip if balance < 1 NOS
3. **Calculate split** based on tier (see below)
4. **Execute transfers** — Two Solana SPL token transfers (user + treasury)
5. **Log** — Record transaction signatures for earnings history

### Fee Tiers (Updated)

| Tier | User Share | Platform Fee | How to Unlock |
|------|-----------|-------------|---------------|
| Free | 90% | 10% | Default — no payment required |
| Pro/VIP | 95% | 5% | One-time 10 SOL payment |

> Previous free tier was 85/15. Updated to 90/10 to match current bondli platform.

### Verifying Earnings

All sweep transactions are standard Solana SPL token transfers. Verify on:

- [Solana Explorer](https://explorer.solana.com)
- [Solscan](https://solscan.io)

The Bondli dashboard shows your complete earnings history with transaction signatures.
