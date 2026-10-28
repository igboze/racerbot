import pg from 'pg';

const BASE_URL = 'http://localhost:3000';
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Set DATABASE_URL (see .env.example) before running this script.');
  process.exit(1);
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  console.log('--- Checking Alpha Traders Leaderboard (Clean Slate) ---');
  const listRes = await fetch(`${BASE_URL}/alpha/traders`);
  const listData = await listRes.json();
  console.log('✓ Alpha Callers Count on Leaderboard:', listData.traders?.length);

  console.log('\n--- Testing Creator Registration Flow ---');
  const regRes = await fetch(`${BASE_URL}/alpha/creator/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      handle: 'apex_alpha_test',
      displayName: 'Apex Alpha Syndicate',
      bio: 'Verified Production Alpha Channel',
      strategyTag: 'Confidential Snipe',
      keyPriceNear: 3.5,
      tierBasicPriceNear: 1.5,
      tierCopyPriceNear: 3.5,
      tierPremiumPriceNear: 8.0,
      walletAddress: 'apex_trader.near',
      txHash: 'tx_entry_fee_verified'
    })
  });
  const regData = await regRes.json();
  console.log('✓ Registered Creator:', regData);

  const updatedListRes = await fetch(`${BASE_URL}/alpha/traders`);
  const updatedListData = await updatedListRes.json();
  console.log('✓ Updated Leaderboard Count:', updatedListData.traders?.length, `(@${updatedListData.traders?.[0]?.handle})`);

  // Cleanup test registration
  console.log('\n--- Cleaning up test registration ---');
  await pool.query("DELETE FROM racer_alpha_traders WHERE handle = 'apex_alpha_test'");
  await pool.query("DELETE FROM racer_alpha_creator_payments WHERE wallet_address = 'apex_trader.near'");
  console.log('✓ Cleaned up test creator');

  const finalListRes = await fetch(`${BASE_URL}/alpha/traders`);
  const finalListData = await finalListRes.json();
  console.log('✓ Final Leaderboard Count (Clean Slate):', finalListData.traders?.length);

  await pool.end();
}

main().catch(console.error);
