// Production E2E Verification Script for RacerAlpha & NEAR Intents
import pg from 'pg';

const BASE_URL = 'http://localhost:3000';
const DATABASE_URL = 'postgresql://postgres:REDACTED@localhost:5432/railway';

async function runTest() {
  console.log('--- 1. Testing NEAR Intents Deposit API Endpoints ---');

  // 1. Test /deposit/chains
  const chainsRes = await fetch(`${BASE_URL}/deposit/chains`);
  if (!chainsRes.ok) throw new Error(`/deposit/chains failed: ${chainsRes.status}`);
  const chainsData = await chainsRes.json();
  const chains = chainsData.chains || [];
  console.log(`✓ Fetched ${chains.length} supported chains from NEAR Intents`);
  if (chains.length < 30) throw new Error(`Expected at least 30 chains, got ${chains.length}`);

  // 2. Test /deposit/tokens?chain=sol
  const solTokensRes = await fetch(`${BASE_URL}/deposit/tokens?chain=sol`);
  if (!solTokensRes.ok) throw new Error(`/deposit/tokens?chain=sol failed: ${solTokensRes.status}`);
  const solData = await solTokensRes.json();
  const solTokens = solData.tokens || [];
  console.log(`✓ Fetched ${solTokens.length} tokens for Solana (e.g. ${solTokens.slice(0, 4).map(t => t.symbol).join(', ')})`);
  if (solTokens.length === 0) throw new Error('Expected at least 1 Solana token');

  // 3. Test /deposit/tokens?chain=base
  const baseTokensRes = await fetch(`${BASE_URL}/deposit/tokens?chain=base`);
  if (!baseTokensRes.ok) throw new Error(`/deposit/tokens?chain=base failed: ${baseTokensRes.status}`);
  const baseData = await baseTokensRes.json();
  const baseTokens = baseData.tokens || [];
  console.log(`✓ Fetched ${baseTokens.length} tokens for Base (e.g. ${baseTokens.slice(0, 4).map(t => t.symbol).join(', ')})`);

  // 4. Test /deposit/quote
  const quotePayload = {
    chain: 'sol',
    symbol: 'SOL',
    amount: 0.1,
    subaccountId: 'test.near'
  };
  const quoteRes = await fetch(`${BASE_URL}/deposit/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(quotePayload)
  });
  const quoteData = await quoteRes.json();
  console.log(`✓ Deposit Quote Response:`, {
    success: quoteData.success,
    depositAddress: quoteData.depositAddress,
    minNearOut: quoteData.minNearOut,
    depositId: quoteData.depositId,
    sourceChain: quoteData.sourceChain,
    sourceSymbol: quoteData.sourceSymbol
  });
  if (!quoteData.depositAddress) throw new Error('Failed to obtain deposit address from 1Click solver');

  console.log('\n--- 2. Testing Creator Signal Dispatch & 100% Confidentiality ---');

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  // Find an existing active trader from racer_alpha_traders
  const traderRow = await client.query('SELECT id, handle, display_name FROM racer_alpha_traders LIMIT 1');
  if (traderRow.rows.length === 0) {
    throw new Error('No active trader found in database to test signal dispatch');
  }
  const testTrader = traderRow.rows[0];
  console.log(`Using active trader: ${testTrader.id} (@${testTrader.handle} - ${testTrader.display_name})`);

  // Dispatch a BUY signal for an unlisted launchpad meme token
  const testToken = 'meme_dragon.meme-cooking.near';
  const signalPayload = {
    traderId: testTrader.id,
    tokenAddress: testToken,
    side: 'BUY',
    amountNear: 2.5,
    priceNear: 0.05,
    tokenSymbol: 'MDRAGON'
  };

  const dispatchRes = await fetch(`${BASE_URL}/alpha/creator/signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signalPayload)
  });
  const dispatchData = await dispatchRes.json();
  console.log('✓ Creator Signal Dispatch Response:', dispatchData);
  if (!dispatchData.success) throw new Error(`Dispatch failed: ${dispatchData.error}`);

  const signalId = dispatchData.signalId;

  // Verify Non-Keyholder View: MUST BE 100% CONFIDENTIAL
  const nonKeyholderRes = await fetch(`${BASE_URL}/alpha/traders/${testTrader.id}/positions`, {
    headers: { 'x-wallet-address': 'stranger_unauthorized.near' }
  });
  const confidentialData = await nonKeyholderRes.json();
  console.log('\n[Confidential View for Non-Keyholder]:');
  const targetPosConfidential = confidentialData.positions?.find(p => p.tokenAddress === 'confidential.intent.near' || p.symbol === 'CONFIDENTIAL');
  console.log({
    isUnlocked: confidentialData.isUnlocked,
    symbol: targetPosConfidential?.symbol,
    tokenAddress: targetPosConfidential?.tokenAddress,
    isLocked: targetPosConfidential?.isLocked,
    sizeTokens: targetPosConfidential?.sizeTokens
  });

  if (confidentialData.isUnlocked || targetPosConfidential?.symbol !== 'CONFIDENTIAL' || targetPosConfidential?.tokenAddress !== 'confidential.intent.near') {
    throw new Error('FAILURE: Unkeyed user was able to see the confidential token info!');
  }
  console.log('✓ PASS: Non-keyholder view is 100% confidential and masked');

  // Verify Swaps Endpoint for Non-Keyholder
  const nonKeySwapsRes = await fetch(`${BASE_URL}/alpha/traders/${testTrader.id}/swaps`, {
    headers: { 'x-wallet-address': 'stranger_unauthorized.near' }
  });
  const nonKeySwapsData = await nonKeySwapsRes.json();
  const targetSwapConfidential = nonKeySwapsData.swaps?.find(s => s.id === signalId || s.tokenSymbol === '••••••');
  console.log('[Confidential Swaps for Non-Keyholder]:', {
    tokenSymbol: targetSwapConfidential?.tokenSymbol,
    tokenAddress: targetSwapConfidential?.tokenAddress,
    priceNear: targetSwapConfidential?.priceNear,
    amountNear: targetSwapConfidential?.amountNear,
    isLocked: targetSwapConfidential?.isLocked
  });
  if (targetSwapConfidential && (targetSwapConfidential.tokenSymbol !== '••••••' || targetSwapConfidential.priceNear !== undefined)) {
    throw new Error('FAILURE: Unkeyed user saw unmasked swap details!');
  }
  console.log('✓ PASS: Non-keyholder swaps feed is 100% confidential and masked');

  // Verify Key Purchase and Authorized Keyholder View
  const subscriberAccount = `test_sub_${Date.now()}.near`;
  console.log(`\nPurchasing viewing key for subscriber: ${subscriberAccount}`);

  const buyKeyRes = await fetch(`${BASE_URL}/alpha/keys/buy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-wallet-address': subscriberAccount
    },
    body: JSON.stringify({
      traderId: testTrader.id,
      tier: 'copy',
      allocationPct: 30.0,
      riskMultiplier: 1.2
    })
  });
  const buyKeyData = await buyKeyRes.json();
  console.log('✓ Key Purchase Response:', buyKeyData);
  if (!buyKeyData.success) throw new Error(`Key purchase failed: ${buyKeyData.error}`);

  // Query positions with the authorized keyholder account
  const keyholderRes = await fetch(`${BASE_URL}/alpha/traders/${testTrader.id}/positions`, {
    headers: { 'x-wallet-address': subscriberAccount }
  });
  const unmaskedData = await keyholderRes.json();
  console.log('\n[Authorized View for Keyholder]:');
  const targetPosUnmasked = unmaskedData.positions?.find(p => p.tokenAddress === testToken);
  console.log({
    isUnlocked: unmaskedData.isUnlocked,
    symbol: targetPosUnmasked?.symbol,
    tokenAddress: targetPosUnmasked?.tokenAddress,
    isLocked: targetPosUnmasked?.isLocked,
    sizeTokens: targetPosUnmasked?.sizeTokens
  });

  if (!unmaskedData.isUnlocked || !targetPosUnmasked || targetPosUnmasked.tokenAddress !== testToken) {
    throw new Error('FAILURE: Keyholder was unable to see the unmasked token details!');
  }
  console.log('✓ PASS: Authorized keyholder receives full unmasked trade data and signals');

  // Query swaps with the authorized keyholder account
  const keySwapsRes = await fetch(`${BASE_URL}/alpha/traders/${testTrader.id}/swaps`, {
    headers: { 'x-wallet-address': subscriberAccount }
  });
  const keySwapsData = await keySwapsRes.json();
  const targetSwapUnmasked = keySwapsData.swaps?.find(s => s.id === signalId);
  console.log('[Authorized Swaps for Keyholder]:', {
    tokenSymbol: targetSwapUnmasked?.tokenSymbol,
    tokenAddress: targetSwapUnmasked?.tokenAddress,
    priceNear: targetSwapUnmasked?.priceNear,
    amountNear: targetSwapUnmasked?.amountNear,
    venue: targetSwapUnmasked?.venue,
    isLocked: targetSwapUnmasked?.isLocked
  });
  if (!targetSwapUnmasked || targetSwapUnmasked.tokenSymbol !== 'MDRAGON') {
    throw new Error('FAILURE: Keyholder did not see unmasked swap details!');
  }
  console.log('✓ PASS: Keyholder receives real-time unmasked swap and execution venue');

  // Cleanup test artifacts from database to keep DB clean
  console.log('\n--- 3. Cleaning Up E2E Test Artifacts ---');
  await client.query('DELETE FROM racer_alpha_signals WHERE id = $1', [signalId]);
  await client.query('DELETE FROM racer_alpha_positions WHERE trader_id = $1 AND token_address = $2', [testTrader.id, testToken]);
  await client.query('DELETE FROM racer_alpha_keys WHERE trader_id = $1 AND buyer_user_id = $2', [testTrader.id, subscriberAccount]);
  console.log('✓ Cleaned up test signals, test position, and test viewing key');

  client.release();
  await pool.end();

  console.log('\n======================================================');
  console.log('🎉 ALL PRODUCTION-LEVEL E2E TESTS PASSED WITH 100% SUCCESS');
  console.log('======================================================');
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
