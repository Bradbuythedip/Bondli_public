# BONDLI.FUN — Ship It Guide (Railway + Vercel)

You know Vercel and Railway. No Docker, no nginx, no VPS SSH.
This gets you live in 30 minutes.

---

## Architecture (What Goes Where)

```
Vercel          Railway              Solana
(frontend)      (backend + redis)    (mainnet)
   |                |                   |
   |  bondli.fun    |  api.bondli.fun   |
   |                |                   |
   +--- REST/WS --->+--- RPC ---------> +
   |                |                   |
   |  React SPA     |  Express + WS     |  Helius RPC
   |  Static files  |  Redis            |  Payment verify
   |  CDN edge      |  Payment system   |  Bonding curve
   |                |  Fee engine       |  Jupiter swaps
```

Frontend on Vercel (free, fast, you know it).
Backend on Railway (cheap, handles WebSockets, has Redis plugin).

---

## STEP 0: Prep (5 min)

You need these accounts/keys ready:

1. **GitHub** — you already have this
2. **Vercel** — you already have this
3. **Railway** — sign up at railway.com (link GitHub)
4. **Helius** — helius.dev, grab an API key (free tier works for demo)
5. **A Solana wallet** — you need the bs58 private key for your master wallet
   - This is the wallet that funds sub-wallets
   - Use a FRESH wallet with a small amount for demo (1-2 SOL)
   - Export private key from Phantom: Settings > Security > Export Private Key

Generate your secrets now (run locally):

```bash
node -e "
const c = require('crypto');
console.log('JWT_SECRET=' + c.randomBytes(32).toString('hex'));
console.log('API_SECRET=' + c.randomBytes(32).toString('hex'));
console.log('FEE_SALT=' + c.randomBytes(8).toString('hex'));
"
```

Save that output. You'll paste it into Railway in step 3.

---

## STEP 1: Push to GitHub (2 min)

Take both zips I gave you (bondli-v3.0.zip + bondli-production-stack.zip).
Merge them into one repo:

```bash
# Unzip the base repo
unzip bondli-v3.0.zip
cd bondli

# Unzip production stack and merge
unzip ../bondli-production-stack.zip
cp -r bondli-prod/src/middleware src/
cp -r bondli-prod/src/payments src/
cp -r bondli-prod/src/db src/
cp bondli-prod/src/api/server.production.mjs src/api/
cp bondli-prod/app/src/api.js app/src/
cp bondli-prod/package.production.json package.json
cp bondli-prod/.env.production.template .env.production.template

# Init repo
git init
git add -A
git commit -m "bondli v3.0 initial"

# Create GitHub repo (via github.com or gh cli)
gh repo create bondli --private --source=. --push
# OR
git remote add origin git@github.com:YOUR_USERNAME/bondli.git
git push -u origin main
```

---

## STEP 2: Deploy Backend on Railway (10 min)

### 2a. Create project

1. Go to **railway.com/new**
2. Click **"Deploy from GitHub Repo"**
3. Select your `bondli` repo
4. Railway auto-detects Node.js

### 2b. Add Redis

1. In your Railway project, click **"+ New"**
2. Select **"Database" > "Redis"**
3. It spins up instantly
4. Click the Redis service > **Variables** tab
5. Copy the `REDIS_URL` (looks like `redis://default:password@containers-us-west-xxx.railway.app:6379`)

### 2c. Configure the API service

Click your main service (the GitHub one) > **Settings** tab:

- **Root Directory**: leave blank (root of repo)
- **Build Command**: `npm install`
- **Start Command**: `node src/api/server.production.mjs`
- **Health Check Path**: `/api/health`

### 2d. Set environment variables

Go to **Variables** tab. Add ALL of these:

```
NODE_ENV=production
API_PORT=3001

# Network
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
HELIUS_API_KEY=YOUR_HELIUS_KEY

# Atlas (set false for demo, true if you have paid Helius)
USE_HELIUS_ATLAS=false
HELIUS_SEND_TX_URL=
HELIUS_SMART_TX=false

# Wallet (your fresh demo wallet private key, bs58)
MASTER_SEED=YOUR_BS58_PRIVATE_KEY

# Budget
TOTAL_SOL=1
DRY_RUN=true

# Trading
SLIPPAGE_BPS=2500
PRIORITY_FEE=100000
JITO_TIP=10000
RUN_DURATION_MINUTES=60

# Secrets (from step 0)
JWT_SECRET=paste_from_step_0
API_SECRET=paste_from_step_0
FEE_SALT=paste_from_step_0

# Platform
PLATFORM_WALLET=anal.sol
PLATFORM_WALLET_RESOLVED=YOUR_ANAL_SOL_RESOLVED_PUBKEY
ACCESS_FEE_SOL=0.1

# Anti-Sniper
PURGE_PERCENT=30

# Redis (copy from Redis service)
REDIS_URL=redis://default:xxxxx@containers-us-west-xxx.railway.app:6379
```

**IMPORTANT**: Keep `DRY_RUN=true` until you're ready for real trades.

### 2e. Set up networking

1. Go to **Settings** > **Networking**
2. Click **"Generate Domain"** — Railway gives you something like `bondli-production-xxxx.up.railway.app`
3. OR click **"Custom Domain"** and add `api.bondli.fun`
   - Add a CNAME record in your DNS: `api.bondli.fun -> your-railway-domain.up.railway.app`

### 2f. Deploy

Railway auto-deploys on push. Click **"Deploy"** if it hasn't started.

Watch the build logs. Once you see:

```
BONDLI v3.0 — PRODUCTION SERVER
HTTP:  http://localhost:3001
Mode:  DRY RUN
```

You're good. Test it:

```bash
curl https://your-railway-domain.up.railway.app/api/health
# {"ok":true,"uptime":12.345,"env":"production"}

curl https://your-railway-domain.up.railway.app/api/config
# {"dryRun":true,"totalSol":1,...}

curl https://your-railway-domain.up.railway.app/api/payment/info
# {"wallet":"anal.sol","amount":0.1,...}
```

---

## STEP 3: Deploy Frontend on Vercel (5 min)

### 3a. Update the API base URL

Edit `app/src/api.js`. Change line 1:

```js
const BASE = "https://api.bondli.fun";
// OR if using Railway's generated domain:
const BASE = "https://bondli-production-xxxx.up.railway.app";
```

Commit and push.

### 3b. Deploy on Vercel

1. Go to **vercel.com/new**
2. Import your `bondli` GitHub repo
3. Configure:
   - **Framework Preset**: Vite
   - **Root Directory**: `app`
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
4. No environment variables needed (frontend has no secrets)
5. Click **Deploy**

### 3c. Custom domain

1. In Vercel project > **Settings** > **Domains**
2. Add `bondli.fun`
3. Vercel tells you what DNS records to add:
   - `A` record pointing to Vercel's IP, OR
   - `CNAME` pointing to `cname.vercel-dns.com`
4. SSL is automatic

### 3d. Fix CORS

Go back to Railway. In your API service variables, you need the production server to accept requests from your Vercel domain.

Edit `src/middleware/security.mjs` — update ALLOWED_ORIGINS:

```js
const ALLOWED_ORIGINS = new Set([
  "https://bondli.fun",
  "https://www.bondli.fun",
  "https://bondli-xxx.vercel.app",  // your Vercel preview URL
]);
```

Commit, push. Railway auto-redeploys.

---

## STEP 4: Test End-to-End (5 min)

Open `https://bondli.fun` in your browser.

1. **Payment flow**: The app should show payment info. Send 0.1 SOL to the platform wallet from your Phantom. Paste the tx signature. Backend verifies on-chain, gives you a JWT.

2. **Create tab**: Paste a token CA. Hit Launch. Since DRY_RUN=true, it simulates everything.

3. **Wallets tab**: Shows your generated fleet with roles.

4. **Feed tab**: Shows live trade events via WebSocket.

5. **Config tab**: Shows fee tiers and engine config.

6. **Close All**: Opens skull modal, triggers fee settlement.

If WebSocket doesn't connect, check that Railway supports WS on your plan (it does by default on the Hobby plan and above).

---

## STEP 5: Go Live Checklist

When demo looks good and you're ready for real users:

```
Railway Variables:
  DRY_RUN=false          <- THE BIG SWITCH
  MASTER_SEED=xxx        <- funded wallet with real SOL
```

Before flipping:

- [ ] Master wallet has enough SOL for your budget
- [ ] Helius key is on a plan that handles your RPC volume
- [ ] Payment wallet (anal.sol) resolves correctly
- [ ] You've tested payment verification end-to-end
- [ ] You've done at least one full dry run cycle (launch > trade > close)
- [ ] CORS only allows your domain
- [ ] All secrets are unique random strings (not defaults)

---

## Quick Reference

| What | Where | URL |
|------|-------|-----|
| Frontend | Vercel | bondli.fun |
| API | Railway | api.bondli.fun |
| Redis | Railway | internal (auto-linked) |
| Repo | GitHub | github.com/you/bondli |
| RPC | Helius | mainnet.helius-rpc.com |
| Payments | anal.sol | on-chain verification |

| Command | What it does |
|---------|-------------|
| `git push` | Auto-deploys both Vercel + Railway |
| Railway logs | Click service > "Logs" tab |
| Vercel logs | Click deployment > "Functions" tab |

---

## Costs

| Service | Plan | Monthly |
|---------|------|---------|
| Vercel | Hobby (free) | $0 |
| Railway | Hobby ($5 credit) | $5-15 |
| Helius | Free/Developer | $0-49 |
| Domain | bondli.fun | ~$1 |
| **Total** | | **$6-65** |

Railway bills by usage. A demo with light traffic stays under $5. Real traffic with Redis and sustained WebSocket connections maybe $10-15.

---

## Troubleshooting

**"CORS error" in browser console**
Your Vercel frontend is hitting the Railway API and CORS is blocking it. Make sure ALLOWED_ORIGINS in security.mjs includes your exact Vercel domain (with https://).

**"WebSocket connection failed"**
Railway supports WebSocket but your frontend might be hitting the wrong URL. Make sure the WS connection in api.js uses the Railway domain, not localhost. Update the connectWS function:

```js
export function connectWS(onMessage) {
  const wsUrl = "wss://api.bondli.fun/ws";
  // OR: "wss://bondli-production-xxxx.up.railway.app/ws"
  const ws = new WebSocket(wsUrl);
  // ... rest stays the same
}
```

**"Payment verification failed"**
Check that PLATFORM_WALLET_RESOLVED is the actual pubkey of anal.sol. You can resolve it at bonfida.org or via the SNS CLI. If you can't resolve it, just use a regular pubkey and update PLATFORM_WALLET to match.

**"Redis connection refused"**
Make sure the REDIS_URL in your API service matches what Railway's Redis plugin provides. Click the Redis service > Connect tab > copy the full URL.

**Rate limited during testing**
The rate limiter is aggressive. If you're testing rapidly, temporarily bump the limits in rate-limiter.mjs or add your IP to an allowlist.

---

That's it. Push to GitHub, Railway and Vercel pick it up, you're live.


