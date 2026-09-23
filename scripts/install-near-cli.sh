#!/usr/bin/env bash
set -euo pipefail

# ── RacerBot NEAR CLI Setup ────────────────────────────────────────────────────
# Installs near-cli and Rust WASM target if not already present.

echo "=== RacerBot NEAR CLI Setup ==="

# 1. Check / install near-cli
if command -v near &>/dev/null; then
  echo "✅ near-cli found: $(near --version 2>&1 | head -1)"
else
  echo "📦 Installing near-cli..."
  npm install -g near-cli
  echo "✅ near-cli installed: $(near --version 2>&1 | head -1)"
fi

# 2. Check / install Rust
if command -v rustup &>/dev/null; then
  echo "✅ Rust found: $(rustc --version)"
else
  echo "📦 Installing Rust..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
  echo "✅ Rust installed"
fi

# 3. Add wasm32 target
echo "📦 Adding wasm32-unknown-unknown Rust target..."
rustup target add wasm32-unknown-unknown
echo "✅ WASM target ready"

echo ""
echo "=== Setup complete ==="
echo "Run 'bash scripts/deploy.sh' to build and deploy the contract."
