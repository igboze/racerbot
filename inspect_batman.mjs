import { getDb } from './packages/db/dist/index.js';
import dotenv from 'dotenv';
dotenv.config();

const db = await getDb();

// Check ALL batman sells to understand if any user actually saw 50% price gain but got ~19% PNL
// Focus: find sells where token price was up 40-60% but PNL was only 15-25%
const res = await db.query(`
  SELECT 
    u.telegram_id,
    f.side,
    f.amount,
    f.price,
    f.fee_paid,
    f.created_at,
    p.avg_entry_price,
    p.id as pos_id
  FROM fills f
  JOIN positions p ON p.id = f.position_id
  JOIN users u ON u.id = f.user_id
  WHERE f.token_address = 'batman-4.nearlytrade.near'
    AND f.side IN ('buy', 'sell')
  ORDER BY u.telegram_id, f.created_at
`);

// Group by position
const byPos = {};
for (const r of res.rows) {
  if (!byPos[r.pos_id]) byPos[r.pos_id] = { telegram_id: r.telegram_id, avg_entry: r.avg_entry_price, fills: [] };
  byPos[r.pos_id].fills.push(r);
}

for (const [posId, pos] of Object.entries(byPos)) {
  const buys = pos.fills.filter(f => f.side === 'buy');
  const sells = pos.fills.filter(f => f.side === 'sell');
  if (sells.length === 0) continue;
  
  // Calculate avg buy price from fills (18 decimals)
  let totalCost = 0, totalTokens = 0;
  for (const b of buys) {
    const amt = parseFloat(b.amount) / 1e18;
    const price = parseFloat(b.price);
    const fee = parseFloat(b.fee_paid);
    totalCost += amt * price + fee;
    totalTokens += amt;
  }
  const avgBuyPrice = totalTokens > 0 ? (totalCost - buys.reduce((s,b)=>s+parseFloat(b.fee_paid),0)) / totalTokens : 0;
  
  for (const s of sells) {
    const amt = parseFloat(s.amount) / 1e18;
    const sellPrice = parseFloat(s.price);
    const fee = parseFloat(s.fee_paid);
    const proceeds = amt * sellPrice - fee;
    const costBasis = amt * avgBuyPrice;
    const investedForThisQty = amt * (totalCost / totalTokens);
    
    const tokenPricePct = ((sellPrice - avgBuyPrice) / avgBuyPrice * 100).toFixed(1);
    const realPnlPct = ((proceeds - costBasis) / costBasis * 100).toFixed(1);
    
    if (Math.abs(parseFloat(tokenPricePct)) > 5) {
      console.log({
        telegram_id: pos.telegram_id,
        buy_price: avgBuyPrice.toExponential(4),
        sell_price: sellPrice.toExponential(4),
        token_price_change: tokenPricePct + '%',
        actual_pnl: realPnlPct + '%',
        fee_drag: (parseFloat(tokenPricePct) - parseFloat(realPnlPct)).toFixed(1) + '%',
        sell_time: s.created_at,
      });
    }
  }
}

process.exit(0);
