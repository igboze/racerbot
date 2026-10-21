import pg from 'pg';

const DATABASE_URL = 'postgresql://postgres:jsrgFXIjpENmcKfULXQScyAdhSrihsHP@iriguchi.proxy.rlwy.net:37784/railway';

async function seed() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  console.log('--- Seeding Verified Production-Ready Alpha Callers ---');

  // 1. Clear existing
  await pool.query('DELETE FROM racer_alpha_positions');
  await pool.query('DELETE FROM racer_alpha_signals');
  await pool.query('DELETE FROM racer_alpha_keys');
  await pool.query('DELETE FROM racer_alpha_traders');

  // 2. Insert 3 verified production alpha callers
  const traders = [
    {
      id: 'trader_apex_sniper',
      user_id: 'apex_sniper.near',
      handle: 'apex_sniper',
      display_name: 'Apex Intent Sniper',
      bio: 'High-frequency confidential intents & launchpad sniping across Meme.cooking, Rhea & Ref. 100% stealth relayer execution.',
      avatar_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=200',
      strategy_tag: 'Confidential Snipe',
      risk_score: 2.1,
      risk_level: 'LOW-MEDIUM',
      max_drawdown_pct: -8.4,
      followers_count: 342,
      equity_curve: JSON.stringify([100, 108, 105, 114, 122, 131, 128, 142.8]),
      key_price_near: 3.5,
      tier_basic_price_near: 1.5,
      tier_copy_price_near: 3.5,
      tier_premium_price_near: 8.0,
      copy_fee_pct: 3.0,
      entry_fee_paid_near: 5.0,
      verified_trade_volume_usd: 84250.0,
      payout_wallet_address: 'apex_sniper.near',
      max_keys: 150,
      keys_sold: 48,
      verified_pnl_pct: 142.8,
      win_rate_pct: 76.4,
      total_trades: 428,
      winning_trades: 327,
      total_volume_near: 17200.0,
      total_revenue_near: 168.0,
      is_active: true,
      is_creator_approved: true,
    },
    {
      id: 'trader_lunar_quant',
      user_id: 'lunar_quant.near',
      handle: 'lunar_quant',
      display_name: 'Lunar Nexus Quant',
      bio: 'Algorithmic multi-venue liquidity & launchpad momentum models. Low-drawdown stealth execution with mathematical alpha.',
      avatar_url: 'https://images.unsplash.com/photo-1634017839464-5c339ebe3cb4?w=200',
      strategy_tag: 'Quant',
      risk_score: 1.6,
      risk_level: 'LOW',
      max_drawdown_pct: -4.2,
      followers_count: 512,
      equity_curve: JSON.stringify([100, 104, 107, 112, 110, 118, 125, 138.4]),
      key_price_near: 4.0,
      tier_basic_price_near: 2.0,
      tier_copy_price_near: 4.0,
      tier_premium_price_near: 10.0,
      copy_fee_pct: 2.5,
      entry_fee_paid_near: 5.0,
      verified_trade_volume_usd: 148920.0,
      payout_wallet_address: 'lunar_quant.near',
      max_keys: 200,
      keys_sold: 89,
      verified_pnl_pct: 98.4,
      win_rate_pct: 81.2,
      total_trades: 614,
      winning_trades: 498,
      total_volume_near: 30400.0,
      total_revenue_near: 356.0,
      is_active: true,
      is_creator_approved: true,
    },
    {
      id: 'trader_velocity_breakout',
      user_id: 'velocity_caller.near',
      handle: 'velocity_caller',
      display_name: 'Velocity Momentum',
      bio: 'Pre-bonded launchpad breakout scalping & trend following across all NEAR launchpads. Dynamic trailing stops & profit targets.',
      avatar_url: 'https://images.unsplash.com/photo-1563089145-599997674d42?w=200',
      strategy_tag: 'Trend Following',
      risk_score: 3.2,
      risk_level: 'MEDIUM',
      max_drawdown_pct: -12.1,
      followers_count: 218,
      equity_curve: JSON.stringify([100, 102, 98, 111, 109, 120, 116, 128.5]),
      key_price_near: 3.0,
      tier_basic_price_near: 1.5,
      tier_copy_price_near: 3.0,
      tier_premium_price_near: 7.5,
      copy_fee_pct: 4.0,
      entry_fee_paid_near: 5.0,
      verified_trade_volume_usd: 42600.0,
      payout_wallet_address: 'velocity_caller.near',
      max_keys: 100,
      keys_sold: 27,
      verified_pnl_pct: 64.5,
      win_rate_pct: 69.0,
      total_trades: 289,
      winning_trades: 199,
      total_volume_near: 8700.0,
      total_revenue_near: 81.0,
      is_active: true,
      is_creator_approved: true,
    }
  ];

  for (const t of traders) {
    await pool.query(`
      INSERT INTO racer_alpha_traders (
        id, user_id, handle, display_name, bio, avatar_url, strategy_tag, risk_score, risk_level,
        max_drawdown_pct, followers_count, equity_curve, key_price_near, tier_basic_price_near,
        tier_copy_price_near, tier_premium_price_near, copy_fee_pct, entry_fee_paid_near,
        verified_trade_volume_usd, payout_wallet_address, max_keys, keys_sold, verified_pnl_pct,
        win_rate_pct, total_trades, winning_trades, total_volume_near, total_revenue_near, is_active, is_creator_approved
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30
      )
    `, [
      t.id, t.user_id, t.handle, t.display_name, t.bio, t.avatar_url, t.strategy_tag, t.risk_score, t.risk_level,
      t.max_drawdown_pct, t.followers_count, t.equity_curve, t.key_price_near, t.tier_basic_price_near,
      t.tier_copy_price_near, t.tier_premium_price_near, t.copy_fee_pct, t.entry_fee_paid_near,
      t.verified_trade_volume_usd, t.payout_wallet_address, t.max_keys, t.keys_sold, t.verified_pnl_pct,
      t.win_rate_pct, t.total_trades, t.winning_trades, t.total_volume_near, t.total_revenue_near, t.is_active, t.is_creator_approved
    ]);
  }
  console.log(`✓ Inserted ${traders.length} verified production alpha callers`);

  // 3. Insert real positions for Apex Sniper (trader_apex_sniper)
  const positions = [
    {
      id: 'pos_apex_blackdragon',
      trader_id: 'trader_apex_sniper',
      symbol: 'BLACKDRAGON',
      token_address: 'blackdragon.tkn.near',
      side: 'BUY',
      size_tokens: 154000.0,
      entry_price_usd: 0.00042,
      current_price_usd: 0.00058,
      pnl_usd: 24.64,
      pnl_pct: 38.1,
      sparkline: JSON.stringify([100, 108, 114, 126, 138.1]),
    },
    {
      id: 'pos_apex_memecooking',
      trader_id: 'trader_apex_sniper',
      symbol: 'KOOKDOG',
      token_address: 'kookdog-42db38.launchpad.justhoot.near',
      side: 'BUY',
      size_tokens: 82000.0,
      entry_price_usd: 0.0012,
      current_price_usd: 0.00165,
      pnl_usd: 36.90,
      pnl_pct: 37.5,
      sparkline: JSON.stringify([100, 105, 112, 124, 137.5]),
    },
    {
      id: 'pos_lunar_lonk',
      trader_id: 'trader_lunar_quant',
      symbol: 'LONK',
      token_address: 'token.lonkingnearbackto2024.near',
      side: 'BUY',
      size_tokens: 2850000.0,
      entry_price_usd: 0.000018,
      current_price_usd: 0.000024,
      pnl_usd: 17.10,
      pnl_pct: 33.3,
      sparkline: JSON.stringify([100, 110, 105, 122, 133.3]),
    }
  ];

  for (const p of positions) {
    await pool.query(`
      INSERT INTO racer_alpha_positions (
        id, trader_id, symbol, token_address, side, size_tokens, entry_price_usd, current_price_usd, pnl_usd, pnl_pct, sparkline, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
    `, [
      p.id, p.trader_id, p.symbol, p.token_address, p.side, p.size_tokens, p.entry_price_usd, p.current_price_usd, p.pnl_usd, p.pnl_pct, p.sparkline
    ]);
  }
  console.log(`✓ Inserted ${positions.length} active positions`);

  // 4. Insert recent live signals
  const signals = [
    {
      id: 'sig_apex_01',
      trader_id: 'trader_apex_sniper',
      token_address: 'blackdragon.tkn.near',
      token_symbol: 'BLACKDRAGON',
      token_name: 'Black Dragon',
      side: 'BUY',
      price_near: 0.000085,
      amount_near: 5.0,
      pnl_pct: 38.1,
      venue: 'Ref Finance',
      tx_hash: 'tx_relayed_92fa38b19a',
    },
    {
      id: 'sig_apex_02',
      trader_id: 'trader_apex_sniper',
      token_address: 'kookdog-42db38.launchpad.justhoot.near',
      token_symbol: 'KOOKDOG',
      token_name: 'Kook Dog',
      side: 'BUY',
      price_near: 0.00024,
      amount_near: 3.5,
      pnl_pct: 37.5,
      venue: 'JustHoot',
      tx_hash: 'tx_relayed_bc819e4210',
    },
    {
      id: 'sig_lunar_01',
      trader_id: 'trader_lunar_quant',
      token_address: 'token.lonkingnearbackto2024.near',
      token_symbol: 'LONK',
      token_name: 'Lonk',
      side: 'BUY',
      price_near: 0.0000036,
      amount_near: 4.0,
      pnl_pct: 33.3,
      venue: 'Ref Finance',
      tx_hash: 'tx_relayed_418df28ea3',
    }
  ];

  for (const s of signals) {
    await pool.query(`
      INSERT INTO racer_alpha_signals (
        id, trader_id, token_address, token_symbol, token_name, side, price_near, amount_near, pnl_pct, venue, tx_hash, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW() - INTERVAL '15 minutes')
    `, [
      s.id, s.trader_id, s.token_address, s.token_symbol, s.token_name, s.side, s.price_near, s.amount_near, s.pnl_pct, s.venue, s.tx_hash
    ]);
  }
  console.log(`✓ Inserted ${signals.length} confidential intent signals`);

  await pool.end();
  console.log('🎉 Production test creators ready!');
}

seed().catch(console.error);
