#!/bin/bash
set -e

echo "=== RacerBot Deployment Script ==="

# Check prerequisites
command -v near >/dev/null 2>&1 || { echo "NEAR CLI required"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Docker required"; exit 1; }
command -v psql >/dev/null 2>&1 || { echo "psql required"; exit 1; }

# Deploy contract
echo "Building and deploying router contract..."
cd packages/contract
cargo build --release
near deploy --wasmFile target/wasm32-unknown-unknown/release/racerbot_router.wasm --accountId "$ROUTER_CONTRACT_ID"
cd ../..

# Run migrations
echo "Running database migrations..."
npx drizzle-kit migrate:dev --config packages/db/drizzle.config.ts

# Deploy to Railway
echo "Deploying services to Railway..."
railway project create racerbot
railway service add racerbot-api --dockerfile docker/Dockerfile.api
railway service add racerbot-detector --dockerfile docker/Dockerfile.detector
railway service add racerbot-executor --dockerfile docker/Dockerfile.executor
railway service add racerbot-triggers --dockerfile docker/Dockerfile.triggers
railway plugin add postgresql
railway plugin add redis

echo "Deployment complete!"