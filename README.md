# RacerBot

> **Non-custodial, high-performance automated trading bot for NEAR Protocol and Sui Network.**

RacerBot is an institutional-grade, multi-chain Telegram trading bot and Mini App designed for speed, security, and automation. Built for traders navigating fast-moving meme tokens, launchpad bonding curves, and decentralized exchanges (DEXs), RacerBot combines sub-second execution with automated risk controls, anti-rug safety screening, and a strictly non-custodial security architecture.

---

## 🔗 Official Links

- **Telegram Bot**: [@racertradingbot](https://t.me/racertradingbot)
- **Community Chat**: [t.me/racerbot_community](https://t.me/racerbot_community)
- **Announcements**: [t.me/racertrading](https://t.me/racertrading)
- **Twitter / X**: [@racertradingbot](https://x.com/racertradingbot)
- **NEAR Builders Activity**: [activity.nearbuilders.org](https://activity.nearbuilders.org/activity-sources)

---

## 🚀 Key Features

### ⚡ Sub-Second Swaps & Pre-Warmed Routing
- **Smart Atomic Router**: Proprietary Rust smart contract (`router.racerbot.near`) batches multi-hop swaps, storage registrations, and fee collection into a single atomic transaction.
- **Hedged Multi-RPC Architecture**: Concurrent speculative view calls across FastNEAR, QuickNode, and public endpoints; first response wins to eliminate RPC latency spikes.
- **Nonce & Access Key Management**: Pinned write endpoints and persistent nonce caches prevent `InvalidNonce` broadcast collisions under heavy trading load.

### 🌐 Multi-Chain Liquidity
- **NEAR Protocol**:
  - **DEXs & AMMs**: Ref Finance (v2 AMM & DCL concentrated liquidity), Rhea DEX.
  - **Launchpads & Bonding Curves**: ShardsMarket, NearlyTrade, Intear, MemeCooking, OneTokenHub, Gaypad, Nearpad, ShoreMarkets, Kelytra, NearPumpFun.
- **Sui Network**:
  - Native Sui wallet generation and key management.
  - Cetus DEX and Hop.ag aggregator integration for best-price routing.
  - Deep integration with Sui pump.fun bonding curves.

### 🎯 Automated Sniping & Pool Detection
- **Real-Time Block Watcher**: Continuously monitors blocks for newly deployed token contracts, pair creations, and initial liquidity additions.
- **Targeted Token Snipes**: Place pre-launch snipe orders that trigger the millisecond pool liquidity goes live.
- **Deployer Auto-Sniping**: Automatically snipe tokens launched by vetted deployers matching custom liquidity and market cap filters.
- **Pre-Warmed Storage Deposits**: Automatically pre-registers FT storage on-chain prior to pool launch to ensure zero-delay first-block buys.

### 📈 Advanced Trading Automation
- **Take-Profit (TP) & Stop-Loss (SL)**: Set multi-tier profit targets and stop-loss boundaries with automated execution and real-time PnL cards.
- **Limit Orders**: Native on-chain limit buy and limit sell orders with automated price tracking.
- **DCA (Dollar-Cost Averaging)**: Schedule recurring automated token purchases over custom time intervals.
- **Copy Trading**: Follow top-performing master wallets and automatically mirror their buy and sell transactions with custom sizing limits.

### 🛡️ Anti-Rug & Safety Screening
- **Fail-Closed Rug Checks**: Real-time honeypot screening evaluates creator token balances, contract holding percentages, freeze authorities, and liquidity lock status.
- **Bubblemap & Sybil Analysis**: Interactive visual holder distribution and sybil clustering viewer built directly into the Telegram interface.
- **Verified Token Whitelisting**: Automated recognition of audited launchpad contracts and verified ecosystem assets.

### 💼 Portfolio & Multi-Wallet Management
- **Multi-Wallet Support**: Create, import, switch, rename, and manage multiple NEAR and Sui wallets within a single Telegram account.
- **Live On-Chain Balance Reconciliation**: Automatically monitors live contract balances via RPC upon refresh (`/holdings`, `/bags`, or "🔄 Refresh") and removes externally transferred or sold tokens immediately.
- **Dynamic PnL & Token Cards**: Generates branded, high-resolution shareable PnL cards and interactive token analytics graphics.

### 📢 Group Buy Bot Alerts
- Add RacerBot to any Telegram group or channel to broadcast custom buy alerts with media banners, market cap metrics, whale icons, and 1-click buy buttons.

### 🏛️ NEAR Builders Activity Integration
- Cryptographically signs and publishes on-chain activity events (`trade.buy`, `trade.sell`, `snipe.executed`) to Nostr relays via the [NEAR Builders Activity protocol](https://activity.nearbuilders.org), contributing to global ecosystem leaderboards and portable user reputation.

---

## 🔒 Security Architecture

1. **Non-Custodial Design**:
   - Full-access private keys and seed phrases are generated client-side inside the Telegram Mini App.
   - The RacerBot backend never stores or accesses a user's full-access private key.

2. **Scoped Function-Call Access Keys**:
   - Users grant the bot backend an encrypted, restricted **Function-Call Access Key**.
   - This key is strictly permissioned to call only the `execute_swap` method on `router.racerbot.near`.
   - The scoped key has zero ability to transfer native NEAR, send tokens directly, delete accounts, or add new keys.

3. **AES-256-GCM Encryption**:
   - Scoped access keys and wallet credentials are encrypted at rest using `AES-256-GCM` with secure random IVs and authenticated tags.

4. **Atomic Fee Skimming**:
   - Trading fees are calculated and deducted atomically inside the smart contract during the swap execution—never via secondary transactions.

---

## 🏗️ Repository Architecture

RacerBot is organized as a high-performance monorepo using **Turborepo** and **npm workspaces**:

```
racerbot/
├── packages/
│   ├── api/          # Telegram bot handlers (Telegraf), Mini App backend, alerts, and commands
│   ├── detector/     # High-speed block watcher & pool creation scanner across all NEAR launchpads
│   ├── executor/     # Transaction building, warm signing, atomic routing, and fill processing
│   ├── triggers/     # Background monitors for TP/SL triggers, DCA schedules, and limit orders
│   ├── contract/     # Rust smart contract (racerbot-router) compiled to wasm32-unknown-unknown
│   ├── db/           # PostgreSQL schema, connection pooling, and strongly-typed repositories
│   └── shared/       # Cryptography, multi-RPC client, Redis pub/sub, Sui client, Activity protocol
├── docker/           # Dockerfiles for containerized microservice deployments
├── docs/             # Technical architecture guides and specifications
└── scripts/          # Database migration, deployment, and testing utilities
```

---

## 🛠️ Getting Started

### Prerequisites
- **Node.js**: `v20.x` or later (tested on Node `v22` / `v25`)
- **Rust**: `1.95.0` with `wasm32-unknown-unknown` target (for smart contract)
- **PostgreSQL**: `15+`
- **Redis**: `7+`

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/igboze/racerbot.git
cd racerbot

npm install
```

### 2. Configure Environment Variables
Copy the example environment file and fill in your credentials:
```bash
cp .env.example .env
```

Key environment variables:
```env
# Database & Cache
DATABASE_URL=postgres://postgres:password@localhost:5432/racerbot
REDIS_URL=redis://localhost:6379

# Telegram Configuration
TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
ADMIN_USERNAMES=your_telegram_username

# NEAR Protocol Configuration
ROUTER_CONTRACT_ID=router.racerbot.near
TREASURY_ACCOUNT_ID=racerbottreasury.near
RACERBOT_PARENT_ACCOUNT=racerbot.near
RPC_PROVIDERS=https://rpc.mainnet.fastnear.com,https://free.rpc.fastnear.com

# Key Encryption
KEY_ENCRYPTION_MASTER_KEY=your_64_character_hex_master_key

# NEAR Builders Activity Integration
NEAR_ACTIVITY_API_KEY=act_your_source_api_key
ACTIVITY_API_BASE_URL=https://activity.nearbuilders.org/api
```

### 3. Run Database Migrations
```bash
npm run build --workspace=@racerbot/db
npm run migrate --workspace=@racerbot/db
```

### 4. Build the Workspace
Build all packages across the monorepo:
```bash
npx turbo run build
```

### 5. Start Services Locally
Run each microservice independently or in parallel:
```bash
# Start Telegram bot and Mini App API
npm run dev:api

# Start block and launchpad pool detector
npm run dev:detector

# Start trade execution engine
npm run dev:executor

# Start TP/SL, DCA, and limit order triggers
npm run dev:triggers
```

---

## 📦 Smart Contract (`packages/contract`)

The smart contract is written in Rust using `near-sdk` 5.29.1 and compiled to WebAssembly.

- **Pinned Rust Toolchain**: Rust `1.95.0` (configured in `packages/contract/rust-toolchain.toml`)
- **Compilation Target**: `wasm32-unknown-unknown`

### Build Smart Contract
```bash
npm run build --workspace=@racerbot/contract
# or
cd packages/contract && cargo build --target wasm32-unknown-unknown --release
```

### Run Contract Tests
```bash
cd packages/contract
AWS_LC_SYS_PREBUILT_NASM=1 cargo test
```

---

## 🚢 Deployment

RacerBot is designed for containerized deployment across platforms like **Railway**, **Fly.io**, or **Docker Compose**.

### Docker Deployment
Build individual service images using the Dockerfiles in `docker/`:
```bash
docker build -f docker/Dockerfile.api -t racerbot-api .
docker build -f docker/Dockerfile.executor -t racerbot-executor .
docker build -f docker/Dockerfile.detector -t racerbot-detector .
docker build -f docker/Dockerfile.triggers -t racerbot-triggers .
```

### Deploying to Railway
```bash
bash scripts/deploy.sh
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).