# RacerBot

Non-custodial, fully automated NEAR trading bot.

## Architecture

![Architecture](docs/ARCHITECTURE.md)

### Services
- **racerbot-api** — Telegram bot + Mini App backend
- **racerbot-detector** — Block watcher for new tokens/pools
- **racerbot-executor** — Warm signing and transaction broadcasting
- **racerbot-triggers** — Stop-loss, take-profit, and market-cap triggers

### Key Principles
1. **Non-custodial**: User private keys never leave the browser
2. **Scoped access keys**: Only `execute_swap` on router contract
3. **Atomic fees**: Fees skimmed inside router contract, no separate transaction
4. **Single Postgres**: One database for everything
5. **Multi-RPC**: No single point of failure

## Quick Start

```bash
# Install dependencies
npm install

# Set environment
cp .env.example .env

# Start all services
npm run dev:api
npm run dev:detector
npm run dev:executor
npm run dev:triggers

# Deploy to Railway
bash scripts/deploy.sh
```

## Documentation
- [Architecture](docs/ARCHITECTURE.md)
- [Development](docs/DEVELOPMENT.md)

## Smart Contract (`packages/contract`)

- **Pinned Rust Toolchain**: Rust `1.95.0` (specified in `packages/contract/rust-toolchain.toml`).
- **Target**: `wasm32-unknown-unknown`
- **Dependencies**: Uses `near-sdk` 5.29.1 (requires Rust 1.93+) and Cargo lockfile format v4.
- **Build**:
  ```bash
  npm run build --workspace=@racerbot/contract
  # or
  cargo build --target wasm32-unknown-unknown --release
  ```
- **Tests**:
  ```bash
  AWS_LC_SYS_PREBUILT_NASM=1 cargo test
  ```


## Security
- Full-access private keys are generated client-side in the Mini App
- Backend stores only encrypted scoped function-call access keys
- Seed phrases are shown once to users — RacerBot cannot recover them
- Fail-closed rug checks: if a check cannot complete, auto-buy is skipped