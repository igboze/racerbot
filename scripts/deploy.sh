#!/usr/bin/env bash
set -euo pipefail

# ── RacerBot Deploy Script ─────────────────────────────────────────────────────

ROUTER_CONTRACT="${ROUTER_CONTRACT_ID:-router.racerbot.near}"
WASM_PATH="packages/contract/target/wasm32-unknown-unknown/release/racerbot_router.wasm"

echo "=== RacerBot Deploy ==="
echo "Contract: $ROUTER_CONTRACT"

# 1. Check near-cli
if ! command -v near &>/dev/null; then
  echo "❌ near-cli not found. Run: bash scripts/install-near-cli.sh"
  exit 1
fi

# 2. Build contract
echo ""
echo "📦 Building router contract..."
(
  cd packages/contract
  cargo build --target wasm32-unknown-unknown --release 2>&1
)

if [ ! -f "$WASM_PATH" ]; then
  echo "❌ WASM build failed — file not found: $WASM_PATH"
  exit 1
fi
echo "✅ Contract built: $WASM_PATH ($(du -sh "$WASM_PATH" | cut -f1))"

# 3. Deploy
echo ""
echo "🚀 Deploying to $ROUTER_CONTRACT..."
near deploy \
  --accountId "$ROUTER_CONTRACT" \
  --wasmFile "$WASM_PATH"

echo ""
echo "✅ Contract deployed!"
TREASURY_ACCOUNT="${TREASURY_ACCOUNT_ID:-treasury.racerbot.near}"
echo "📋 Next: Initialize contract (run once after fresh deploy with 1.5% BUY/SELL fees)"
echo "  near call $ROUTER_CONTRACT new '{\"owner_id\":\"$ROUTER_CONTRACT\",\"treasury_id\":\"$TREASURY_ACCOUNT\",\"buy_fee_bps\":150,\"sell_fee_bps\":150,\"snipe_fee_bps\":150}' --accountId $ROUTER_CONTRACT"

# 4. Build TypeScript services
echo ""
echo "📦 Building TypeScript services..."
npm run build

echo ""
echo "=== Deploy complete ==="