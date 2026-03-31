# Bondli — Repo Structure

```
bondli/
├── app/                              # Frontend (React/Vite)
│   ├── src/
│   │   ├── App.jsx                   # Main SPA — all 5 tabs + GPU Alpha Tools UI
│   │   ├── IntelDashboard.jsx        # Intel analytics panel
│   │   ├── MemeticRadar.jsx          # Token radar view
│   │   ├── api.js                    # Legacy API client
│   │   ├── main.jsx                  # App entry point
│   │   ├── hooks/
│   │   │   └── useSolPrice.js        # SOL price hook
│   │   └── lib/
│   │       ├── api-client.js         # API client (78+ methods)
│   │       ├── constants.js          # Constants (API URL, WS URL)
│   │       ├── theme.js              # Theme definitions (dark/light)
│   │       └── utils.js              # Utilities
│   ├── public/
│   │   ├── gpu-agent.sh              # Served at bondli.fun/gpu-agent.sh
│   │   ├── bondli-heartbeat.sh       # Node heartbeat agent
│   │   └── manifest.json             # PWA manifest
│   ├── index.html                    # SPA entry point
│   ├── vite.config.js                # Vite config (proxy /api → :3001)
│   └── vercel.json                   # Vercel deployment config
│
├── src/
│   ├── api/
│   │   ├── server.production.mjs     # Production server (Express + WS + all routes)
│   │   ├── server.mjs                # Development server
│   │   └── access-check.mjs          # Tier validation (Free/Pro/VIP)
│   │
│   ├── engine/
│   │   │ # ── GPU / Nosana ──
│   │   ├── gpu-earnings.mjs          # GPU node management, earnings, sweep cron
│   │   ├── nosana-client.mjs         # Nosana SDK/REST API client (18 markets)
│   │   ├── nosana-job-router.mjs     # AI inference routing via GPU fleet
│   │   ├── compute-engine.mjs        # Demand-side compute: SOL→NOS swap, job submission
│   │   ├── premium-compute.mjs       # 9 premium GPU alpha tools, NOS burn tracking
│   │   │
│   │   │ # ── AI / Chat ──
│   │   ├── grok-client.mjs           # xAI Grok 4 chat integration
│   │   ├── brad-mind.mjs             # BRAD autonomous AI companion
│   │   ├── brad-client.mjs           # BRAD API client
│   │   ├── brad-paper.mjs            # BRAD paper trading engine
│   │   │
│   │   │ # ── ML Scoring ──
│   │   ├── meme-intelligence.mjs     # Core ML scoring (40+ features)
│   │   ├── memetic-pipeline.mjs      # Meme DNA scoring pipeline
│   │   ├── survivorship-bias.mjs     # Survivor archetype matching
│   │   ├── game-theory.mjs           # Bayesian opponent modeling
│   │   ├── meta-engine.mjs           # Narrative lifecycle tracking
│   │   ├── velocity-scorer.mjs       # Score velocity + acceleration
│   │   ├── trajectory-classifier.mjs # Chart pattern classification
│   │   ├── lora-client.mjs           # LoRA model inference client
│   │   │
│   │   │ # ── Rug Detection ──
│   │   ├── rug-scanner.mjs           # 12+ rug detection signals
│   │   ├── artwork-scanner.mjs       # Perceptual hash + CLIP image forensics
│   │   ├── exit-liquidity-detector.mjs # Exit liquidity analysis
│   │   ├── dev-wallet-tracker.mjs    # Dev wallet profiling
│   │   ├── smart-money-tracker.mjs   # Profitable wallet tracking + categorization
│   │   ├── demand-authenticity.mjs   # Wash trading detection
│   │   ├── volume-legitimacy.mjs     # Volume legitimacy analysis
│   │   ├── counterparty-intel.mjs    # Counterparty intelligence
│   │   │
│   │   │ # ── Trading ──
│   │   ├── fleet-trader.mjs          # Multi-wallet fleet trading
│   │   ├── fleet-brains.mjs          # Fleet personality archetypes
│   │   ├── trade-router.mjs          # Trade execution routing
│   │   ├── trade-attribution.mjs     # Trade outcome attribution
│   │   ├── fee-engine.mjs            # Fee calculation + referrals
│   │   ├── session-manager.mjs       # Trading session lifecycle
│   │   ├── pumpfun-client.mjs        # Pump.fun bonding curve client
│   │   ├── bags-client.mjs           # Bags.fm / Meteora DBC client
│   │   ├── raydium-client.mjs        # Raydium AMM client + Jupiter swaps
│   │   ├── launch-orchestrator.mjs   # Token launch coordination
│   │   ├── token-creator.mjs         # Token creation
│   │   ├── orchestrator.mjs          # Main orchestration loop
│   │   ├── exit.mjs                  # Exit execution engine
│   │   ├── recover.mjs               # Position recovery
│   │   ├── simulator.mjs             # Trade simulation engine
│   │   │
│   │   │ # ── Intelligence ──
│   │   ├── forward-radar.mjs         # Upstream trend detection
│   │   ├── resurgence-scanner.mjs    # Comeback play detection
│   │   ├── x-social-intel.mjs        # Twitter/X social intelligence
│   │   ├── attention-value.mjs       # Attention valuation model
│   │   ├── signal-detector.mjs       # Entry signal detection
│   │   ├── regime-engine.mjs         # Market regime classification
│   │   ├── narrative-lifecycle.mjs   # Narrative stage tracking
│   │   ├── historical-movers.mjs     # Historical mover analysis
│   │   ├── portfolio-correlation.mjs # Portfolio correlation limits
│   │   ├── position-health.mjs       # Position health monitoring
│   │   ├── tilt-detector.mjs         # Emotional tilt detection
│   │   ├── price-feeds.mjs           # Price feed aggregation
│   │   ├── volume-engine.mjs         # Volume analysis engine
│   │   │
│   │   │ # ── Infrastructure ──
│   │   ├── alchemy-client.mjs        # Alchemy RPC client
│   │   ├── anti-detection.mjs        # Bot detection evasion
│   │   ├── wallet-optimizer.mjs      # Wallet gas optimization
│   │   ├── wallet-saver.mjs          # Wallet key management
│   │   ├── rpc-enhanced.mjs          # Enhanced RPC with retries
│   │   ├── benchmarker.mjs           # Performance benchmarking
│   │   └── config.mjs                # Environment configuration
│   │
│   ├── autoape/                      # Auto-trading pipeline
│   │   ├── pipeline.js               # Main auto-ape pipeline
│   │   ├── exit-plan.js              # Exit strategy planning
│   │   ├── sizing.js                 # Position sizing (Kelly criterion)
│   │   ├── recovery.js               # Position recovery
│   │   └── gates/                    # Entry gate checks
│   │       ├── confidence.js         # Confidence threshold
│   │       ├── disqualifiers.js      # Hard reject rules
│   │       ├── execution-window.js   # Timing window
│   │       ├── portfolio.js          # Portfolio limits
│   │       └── viability.js          # Token viability check
│   │
│   ├── scoring/memetic/              # Memetic analysis
│   │   ├── index.js                  # Pipeline coordinator
│   │   ├── linguistic.js             # Language analysis
│   │   ├── visual.js                 # Image analysis (CLIP embeddings)
│   │   ├── absurdity.js              # Absurdity scoring
│   │   ├── community.js              # Community signals
│   │   ├── influencer.js             # KOL detection
│   │   ├── cultural-timing.js        # Cultural moment detection
│   │   ├── temporal.js               # Time-based patterns
│   │   ├── learning-pipeline.js      # Online learning
│   │   ├── workers/                  # Background workers
│   │   │   ├── celebrity-monitor.js
│   │   │   ├── kol-monitor.js
│   │   │   ├── trend-poller.js
│   │   │   ├── viral-tracker.js
│   │   │   ├── market-poller.js
│   │   │   ├── competitor-tracker.js
│   │   │   ├── mindshare-tracker.js
│   │   │   └── launch-counter.js
│   │   └── data/                     # Reference data
│   │       ├── meme-keywords.json
│   │       ├── kol-list.json
│   │       ├── english-10k.json
│   │       └── bigram-frequencies.json
│   │
│   ├── ml/                           # LoRA GPU inference
│   │   ├── serve.py                  # FastAPI scoring server
│   │   ├── model.py                  # BondliScorer (128d, 4 layers, LoRA rank 16)
│   │   ├── train.py                  # Online training from trade outcomes
│   │   └── setup.sh                  # Python environment setup
│   │
│   ├── middleware/                    # Express middleware
│   │   ├── auth.mjs                  # JWT authentication
│   │   ├── rate-limiter.mjs          # Rate limiting
│   │   ├── security.mjs              # Security headers
│   │   ├── validate.mjs              # Input validation
│   │   └── wallet-auth.mjs           # Wallet signature auth
│   │
│   ├── payments/                     # Payment processing
│   │   ├── payment-routes.mjs        # Payment API routes
│   │   └── payment-verifier.mjs      # On-chain payment verification
│   │
│   └── db/                           # Data layer
│       ├── session-store.mjs         # Redis session store
│       └── user-store.mjs            # User data management
│
├── deploy/                           # Deployment
│   ├── Dockerfile                    # Production Docker image
│   ├── docker-compose.yml            # Full stack (API + Redis + Nginx + Certbot)
│   ├── deploy.sh                     # One-command deploy script
│   └── nginx.conf                    # Nginx config (SSL, rate limits, SPA routing)
│
├── bondli-gpu-agent.sh               # GPU node setup script (also served at /gpu-agent.sh)
├── gpu-connect.sh                    # GPU connection helper
├── .env.example                      # Environment variable template
├── GPU_TRAINING_GUIDE.md             # GPU setup and training documentation
├── GRANT_PROPOSAL_ONE_PAGER.md       # Nosana grant proposal
├── NOSANA_GRANT_ANSWERS.md           # Detailed Nosana grant application
├── TECHNICAL_ARCHITECTURE.md         # Full technical architecture doc
└── package.json
```
