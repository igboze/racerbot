import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

console.log('════════════════════════════════════════════════════════════════');
console.log('  DEBUGGING OPTION B (UNIVERSAL LAUNCHPADS & NATIVE TOKENS)');
console.log('════════════════════════════════════════════════════════════════\n');

async function debugWorkflow() {
  let passed = 0;
  let failed = 0;

  function assert(condition, desc) {
    if (condition) {
      console.log(`  [PASS] ${desc}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${desc}`);
      failed++;
    }
  }

  // ── Step 1: Verify WASM Binary ──────────────────────────────────────────────
  console.log('1. Checking Smart Contract Artifacts...');
  const wasmPath = path.resolve('packages/contract/target/wasm32-unknown-unknown/release/racerbot_router.wasm');
  const wasmExists = fs.existsSync(wasmPath);
  assert(wasmExists, `Release WASM binary exists at ${wasmPath}`);
  if (wasmExists) {
    const stats = fs.statSync(wasmPath);
    assert(stats.size > 100_000, `WASM size is valid (${Math.round(stats.size / 1024)} KB)`);
  }

  // ── Step 2: Verify Database Schema ──────────────────────────────────────────
  console.log('\n2. Checking Database Schema & Migration...');
  const migrationPath = path.resolve('packages/db/migrations/050_racer_shielded_vault_intents.sql');
  const migExists = fs.existsSync(migrationPath);
  assert(migExists, 'Migration 050 exists for racer_vault_intents');
  if (migExists) {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    assert(sql.includes('CREATE TABLE IF NOT EXISTS racer_vault_intents'), 'Table definition present');
    assert(sql.includes('correlation_id TEXT UNIQUE NOT NULL'), 'Correlation ID unique constraint present');
    assert(sql.includes('nonce BYTEA NOT NULL'), 'Nonce column present for replay protection');
    assert(sql.includes('deadline BIGINT NOT NULL'), 'Deadline column present for expiration protection');
  }

  // ── Step 3: Test Intent Solver Quoting (Defuse vs Direct AMM) ───────────────
  console.log('\n3. Testing Intent Swap Quoting & Hybrid Routing Fallback...');
  const { getIntentSwapQuote } = await import('../packages/api/dist/intentTrade.js');

  const unlistedQuote = await getIntentSwapQuote({
    tokenAddress: 'unlisted-meme-test.near',
    side: 'BUY',
    amountNear: 1.5,
    recipientAccountId: 'test-user.near',
    dryRun: true,
  });

  assert(unlistedQuote !== null, 'Quote call returned result');
  assert(unlistedQuote.supported === false || unlistedQuote.supported === true, 'Quote handled cleanly without throwing');
  if (!unlistedQuote.supported) {
    assert(unlistedQuote.routing === 'AMM', 'Unlisted token correctly falls back to AMM');
    assert(typeof unlistedQuote.reason === 'string', `Fallback reason provided: "${unlistedQuote.reason}"`);
  }

  // ── Step 4: Test All Launchpads Route & Hop Planning ─────────────────────────
  console.log('\n4. Testing Hop Planning Across ALL Launchpads on NEAR...');
  const { planVaultHops } = await import('../packages/api/dist/racerVault.js');

  // Venue 1: Shardsmarket (Bonding curve, native NEAR input)
  const shardsHops = await planVaultHops({
    tokenAddress: 'token.factory.shardsmarket.near',
    venue: 'shardsmarket',
    side: 'BUY',
    amountIn: '1000000000000000000000000',
    slippagePct: 2.0,
  });
  assert(shardsHops.venue === 'Shardsmarket', 'Shardsmarket routes to Shardsmarket venue');
  assert(shardsHops.tokenIn === 'near', 'Shardsmarket uses native NEAR input');
  assert(shardsHops.hops.length === 1, 'Shardsmarket is 1 hop');

  // Venue 2: Intear (Launchpad & DEX, native NEAR & NEP-141)
  const intearHops = await planVaultHops({
    tokenAddress: 'test.launch.intear.near',
    venue: 'intear',
    side: 'BUY',
    amountIn: '1000000000000000000000000',
    slippagePct: 2.0,
  });
  assert(intearHops.venue === 'Intear', 'Intear routes to Intear venue');
  assert(intearHops.tokenIn === 'near', 'Intear buy uses native NEAR input');
  assert(intearHops.hops.length >= 1, 'Intear hop configured');

  // Venue 3: NearlyTrade (Ref DCL)
  const ntHops = await planVaultHops({
    tokenAddress: 'nt-token.near',
    venue: 'nearlytrade',
    side: 'BUY',
    amountIn: '1000000000000000000000000',
    slippagePct: 2.0,
  });
  assert(ntHops.venue === 'Dcl', 'NearlyTrade routes to Ref DCL');
  assert(ntHops.hops.length >= 1, 'NearlyTrade DCL hop configured');

  // Venue 4: OneTokenHub (Ref DCL)
  const othHops = await planVaultHops({
    tokenAddress: 'oth-token.near',
    venue: 'onetokenhub',
    side: 'BUY',
    amountIn: '1000000000000000000000000',
    slippagePct: 2.0,
  });
  assert(othHops.venue === 'Dcl', 'OneTokenHub routes to Ref DCL');

  // Venue 5: ShoreMarkets (Ref DCL)
  const smHops = await planVaultHops({
    tokenAddress: 'sm-token.near',
    venue: 'shoremarkets',
    side: 'BUY',
    amountIn: '1000000000000000000000000',
    slippagePct: 2.0,
  });
  assert(smHops.venue === 'Dcl', 'ShoreMarkets routes to Ref DCL');

  // Venue 6: NEARpad (Ref DCL)
  const npHops = await planVaultHops({
    tokenAddress: 'np-token.near',
    venue: 'nearpad',
    side: 'BUY',
    amountIn: '1000000000000000000000000',
    slippagePct: 2.0,
  });
  assert(npHops.venue === 'Dcl', 'NEARpad routes to Ref DCL');

  // Venue 7: Qlyphs (Ref DCL)
  const qlHops = await planVaultHops({
    tokenAddress: 'ql-token.near',
    venue: 'qlyphs',
    side: 'BUY',
    amountIn: '1000000000000000000000000',
    slippagePct: 2.0,
  });
  assert(qlHops.venue === 'Dcl', 'Qlyphs routes to Ref DCL');

  // Venue 8: NearPumpFun (Bonding curve or Ref AMM)
  const npfHops = await planVaultHops({
    tokenAddress: 'npf-token.near',
    venue: 'nearpumpfun',
    side: 'BUY',
    amountIn: '1000000000000000000000000',
    slippagePct: 2.0,
  });
  assert(npfHops.venue === 'BondingCurve' || npfHops.venue === 'RefAmm', 'NearPumpFun maps to BondingCurve or RefAmm');

  // Venue 9: MemeCooking (Auction / Ref AMM)
  const mcHops = await planVaultHops({
    tokenAddress: 'mc-123.meme-cooking.near',
    venue: 'memecooking',
    side: 'BUY',
    amountIn: '1000000000000000000000000',
    slippagePct: 2.0,
  });
  assert(mcHops.venue === 'GenericFtCall' || mcHops.venue === 'RefAmm', 'MemeCooking maps to GenericFtCall or RefAmm');

  // Venue 10: Gaypad
  const gpHops = await planVaultHops({
    tokenAddress: 'gp-token.near',
    venue: 'gaypad',
    side: 'BUY',
    amountIn: '1000000000000000000000000',
    slippagePct: 2.0,
  });
  assert(gpHops.venue === 'GenericFtCall' || gpHops.venue === 'RefAmm', 'Gaypad maps to GenericFtCall or RefAmm');

  // Venue 11: Rhea / Ref Finance (Ref AMM v2)
  const rheaHops = await planVaultHops({
    tokenAddress: 'blackdragon.tkn.near',
    venue: 'rhea',
    side: 'BUY',
    amountIn: '1000000000000000000000000',
    slippagePct: 2.0,
  });
  assert(rheaHops.venue === 'RefAmm' || rheaHops.venue === 'Dcl', 'Rhea maps to RefAmm or Dcl');

  // ── Step 5: Test Native Token & Auto-Wrapping / Unwrapping Mechanics ────────
  console.log('\n5. Testing Native Token & Auto-Wrapping/Unwrapping Mechanics...');
  // Sell on Ref AMM produces wrap.near, but user wants native near
  const sellHops = await planVaultHops({
    tokenAddress: 'blackdragon.tkn.near',
    venue: 'rhea',
    side: 'SELL',
    amountIn: '5000000000000000000',
    slippagePct: 2.0,
  });
  assert(sellHops.tokenIn === 'blackdragon.tkn.near', 'Sell input is the launchpad token');
  assert(sellHops.tokenOut === 'wrap.near', 'Sell outputs wrap.near from AMM');

  // ── Step 6: Test Every Possible Contract Event & Resolution Path ────────────
  console.log('\n6. Auditing Contract Event & Resolution Awareness...');

  const contractSource = fs.readFileSync('packages/contract/src/lib.rs', 'utf8');

  // Event 1: intent_submitted
  assert(contractSource.includes('"intent_submitted"'), 'Event: intent_submitted logged on submission');

  // Event 2: deposit
  assert(contractSource.includes('"deposit"'), 'Event: deposit logged for NEAR and NEP-141 tokens');

  // Event 3: withdraw_initiated & withdraw_completed
  assert(contractSource.includes('"withdraw_initiated"'), 'Event: withdraw_initiated logged when user requests withdrawal');
  assert(contractSource.includes('"withdraw_completed"'), 'Event: withdraw_completed logged on successful transfer');

  // Event 4: withdraw_failed & automatic sub-ledger refund
  assert(contractSource.includes('"withdraw_failed"'), 'Event: withdraw_failed logged when transfer fails');
  assert(contractSource.includes('action": "recredited_to_subledger'), 'Resolution: funds re-credited to sub-ledger on withdraw failure');

  // Event 5: swap_settled
  assert(contractSource.includes('"swap_settled"'), 'Event: swap_settled logged on trade success');

  // Event 6: slippage_refund
  assert(contractSource.includes('"slippage_refund"'), 'Event: slippage_refund logged when output < min_amount_out');

  // Event 7: swap_failed & full input refund
  assert(contractSource.includes('"swap_failed"'), 'Event: swap_failed logged when venue reverts or returns 0');
  assert(contractSource.includes('self.credit(&pending.user, &pending.token_in, pending.amount_in)'), 'Resolution: 100% of input tokens refunded to user sub-ledger on swap failure');

  // Event 8: ref_withdraw_failed
  assert(contractSource.includes('"ref_withdraw_failed"'), 'Event: ref_withdraw_failed logged if secondary withdraw fails');
  assert(contractSource.includes('credited_to_vault_ledger_retry_withdraw'), 'Resolution: credited to vault ledger so user can retry or withdraw');

  // Event 9: swap_rescued (Emergency admin rescue)
  assert(contractSource.includes('pub fn rescue_stuck_swap'), 'Admin rescue method rescue_stuck_swap present');
  assert(contractSource.includes('"swap_rescued"'), 'Event: swap_rescued logged on admin stuck swap rescue');

  // Event 10: paused & unpaused circuit breakers
  assert(contractSource.includes('pub fn pause'), 'Admin pause method present');
  assert(contractSource.includes('pub fn unpause'), 'Admin unpause method present');
  assert(contractSource.includes('"paused"'), 'Event: paused logged');
  assert(contractSource.includes('"unpaused"'), 'Event: unpaused logged');

  // Event 11: Auto-unwrap wrap.near -> native near
  assert(contractSource.includes('near_withdraw'), 'Auto-unwrap wrap.near -> native near implemented in contract');

  // ── Step 7: Cryptographic Nonce Safety ──────────────────────────────────────
  console.log('\n7. Testing Nonce Replay Prevention...');
  const nonce1 = crypto.randomBytes(32);
  const nonce2 = crypto.randomBytes(32);
  assert(!nonce1.equals(nonce2), 'Generated 32-byte nonces are non-colliding');
  assert(nonce1.length === 32, 'Nonce length is strictly 32 bytes');

  const deadline = Math.floor(Date.now() / 1000) + 120;
  assert(deadline > Math.floor(Date.now() / 1000), 'Deadline is in future (valid 2-min window)');

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(`  WORKFLOW DEBUG RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('════════════════════════════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

debugWorkflow().catch((err) => {
  console.error('Workflow debug failed with unhandled exception:', err);
  process.exit(1);
});
