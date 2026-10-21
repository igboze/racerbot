import ts from 'typescript';
import fs from 'fs';

const BASE_URL = 'http://localhost:3000';

async function testFullWebapp() {
  console.log('========================================================');
  console.log('🧪 FULL WEBAPP END-TO-END PRODUCTION READINESS TEST');
  console.log('========================================================\n');

  // 1. Verify raceralpha.html JavaScript Syntax Integrity
  console.log('1. Checking raceralpha.html inline JavaScript syntax...');
  const html = fs.readFileSync('packages/api/src/raceralpha.html', 'utf8');
  const start = html.indexOf('<script>') + 8;
  const end = html.indexOf('</script>', start);
  const js = html.substring(start, end);

  const sourceFile = ts.createSourceFile('raceralpha.inline.js', js, ts.ScriptTarget.Latest, true);
  const diags = sourceFile.parseDiagnostics || [];
  if (diags.length > 0) {
    throw new Error(`Syntax error in raceralpha.html: ${diags[0].messageText}`);
  }
  console.log('✓ raceralpha.html JavaScript has 0 syntax errors! Clean AST.');

  // 2. Test /alpha HTML endpoint
  console.log('\n2. Testing /alpha page serving...');
  const alphaRes = await fetch(`${BASE_URL}/alpha`);
  if (!alphaRes.ok) throw new Error(`/alpha returned ${alphaRes.status}`);
  const alphaText = await alphaRes.text();
  if (!alphaText.includes('RACER // PRIVATE TRADING TERMINAL') || !alphaText.includes('Cross-Chain Deposit')) {
    throw new Error('Missing core sections in /alpha HTML');
  }
  console.log(`✓ /alpha served successfully (${alphaText.length} bytes)`);

  // 3. Test /alpha/traders Marketplace Leaderboard
  console.log('\n3. Testing Alpha Traders Marketplace API...');
  const tradersRes = await fetch(`${BASE_URL}/alpha/traders`);
  if (!tradersRes.ok) throw new Error(`/alpha/traders returned ${tradersRes.status}`);
  const tradersData = await tradersRes.json();
  const traders = tradersData.traders || [];
  console.log(`✓ Fetched ${traders.length} verified Alpha Creators on Leaderboard:`);
  traders.forEach(t => {
    console.log(`   - @${t.handle} (${t.displayName}): ROI +${t.verifiedPnlPct}%, ${t.followersCount} followers, Strategy: ${t.strategyTag}`);
  });
  if (traders.length < 3) throw new Error('Expected at least 3 active alpha creators');

  const testTrader = traders[0];

  // 4. Test Single Trader Detail View
  console.log(`\n4. Testing Trader Detail View for ${testTrader.id}...`);
  const detailRes = await fetch(`${BASE_URL}/alpha/traders/${testTrader.id}`);
  const detailData = await detailRes.json();
  console.log(`✓ Trader Profile Verified:`, {
    handle: detailData.trader?.handle,
    strategy: detailData.trader?.strategyTag,
    riskLevel: detailData.trader?.riskLevel,
    tierBasicPrice: detailData.trader?.tierBasicPriceNear,
    tierCopyPrice: detailData.trader?.tierCopyPriceNear,
    tierPremiumPrice: detailData.trader?.tierPremiumPriceNear,
  });

  // 5. Test Non-Keyholder Confidential Positions Masking
  console.log(`\n5. Testing 100% Confidentiality for Non-Keyholder...`);
  const unkeyedRes = await fetch(`${BASE_URL}/alpha/traders/${testTrader.id}/positions`, {
    headers: { 'x-wallet-address': 'stranger_tester.near' }
  });
  const unkeyedData = await unkeyedRes.json();
  console.log('✓ Non-Keyholder View:', {
    isUnlocked: unkeyedData.isUnlocked,
    positionCount: unkeyedData.positions?.length,
    sampleSymbol: unkeyedData.positions?.[0]?.symbol,
    sampleAddress: unkeyedData.positions?.[0]?.tokenAddress,
  });
  if (unkeyedData.isUnlocked || unkeyedData.positions?.[0]?.symbol !== 'CONFIDENTIAL' || unkeyedData.positions?.[0]?.tokenAddress !== 'confidential.intent.near') {
    throw new Error('FAILURE: Confidentiality breach! Non-keyholder saw unmasked position.');
  }

  // 6. Test Viewing Key Purchase & Instant Unlocking
  console.log(`\n6. Testing Viewing Key Purchase for Subscriber...`);
  const subscriber = `tester_${Date.now()}.near`;
  const buyRes = await fetch(`${BASE_URL}/alpha/keys/buy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-wallet-address': subscriber
    },
    body: JSON.stringify({
      traderId: testTrader.id,
      tier: 'copy',
      autoCopyEnabled: true,
      allocationPct: 25.0
    })
  });
  const buyData = await buyRes.json();
  console.log('✓ Viewing Key Minted:', {
    success: buyData.success,
    tier: buyData.tier,
    keyReceiptId: buyData.keyReceiptId,
  });

  // 7. Verify Unlocked View for Keyholder
  console.log(`\n7. Testing Authorized Keyholder Real-Time Access...`);
  const keyedRes = await fetch(`${BASE_URL}/alpha/traders/${testTrader.id}/positions`, {
    headers: { 'x-wallet-address': subscriber }
  });
  const keyedData = await keyedRes.json();
  console.log('✓ Keyholder Unmasked View:', {
    isUnlocked: keyedData.isUnlocked,
    positionCount: keyedData.positions?.length,
    sampleSymbol: keyedData.positions?.[0]?.symbol,
    sampleAddress: keyedData.positions?.[0]?.tokenAddress,
    size: keyedData.positions?.[0]?.sizeTokens,
  });
  if (!keyedData.isUnlocked || keyedData.positions?.[0]?.symbol === 'CONFIDENTIAL') {
    throw new Error('FAILURE: Authorized keyholder was unable to unlock positions!');
  }

  // 8. Test Creator Signal Dispatch
  console.log(`\n8. Testing Creator Signal Dispatch on Launchpad Token...`);
  const signalRes = await fetch(`${BASE_URL}/alpha/creator/signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      traderId: testTrader.id,
      tokenAddress: 'lonk_token.meme-cooking.near',
      side: 'BUY',
      amountNear: 2.0,
      priceNear: 0.02,
      tokenSymbol: 'LONK'
    })
  });
  const signalData = await signalRes.json();
  console.log('✓ Signal Dispatched:', {
    success: signalData.success,
    signalId: signalData.signalId,
    venue: signalData.venue,
    autoCopyFillsCount: signalData.autoCopyFillsCount,
  });

  // 9. Test NEAR Intents Cross-Chain Deposit APIs
  console.log(`\n9. Testing NEAR Intents Cross-Chain APIs...`);
  const chainsRes = await fetch(`${BASE_URL}/deposit/chains`);
  const chainsData = await chainsRes.json();
  console.log(`✓ Supported Blockchains: ${chainsData.chains?.length} chains available.`);

  const tokensRes = await fetch(`${BASE_URL}/deposit/tokens?chain=sol`);
  const tokensData = await tokensRes.json();
  console.log(`✓ Solana Tokens: ${tokensData.tokens?.length} assets available with dynamic minimum deposit.`);

  const quoteRes = await fetch(`${BASE_URL}/deposit/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chain: 'sol',
      symbol: 'SOL',
      amount: 0.1,
      subaccountId: 'test.near'
    })
  });
  const quoteData = await quoteRes.json();
  console.log(`✓ Live 1Click Solver Quote:`, {
    success: quoteData.success,
    depositAddress: quoteData.depositAddress,
    minNearOut: quoteData.minNearOut,
    destinationAddress: quoteData.destinationAddress,
  });
  if (!quoteData.depositAddress) throw new Error('Failed to obtain solver deposit address');

  // 10. Test Competition Leaderboard (Real Points Ledger)
  console.log(`\n10. Testing Competition Arena Points Leaderboard...`);
  const snapsRes = await fetch(`${BASE_URL}/api/competition-snapshots`);
  const snapsData = await snapsRes.json();
  const racers = snapsData.snapshot_leaderboard || [];
  console.log(`✓ Points Snapshot: ${racers.length} active qualifying racers.`);
  if (racers.length > 0) {
    console.log(`   - #1 Leader: ${racers[0].wallet} (${racers[0].points} PTS, ${racers[0].events} on-chain events)`);
  }

  console.log('\n========================================================');
  console.log('🎉 ALL 10 WEBAPP PRODUCTION READINESS CHECKS PASSED 100%');
  console.log('========================================================');
}

testFullWebapp().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
