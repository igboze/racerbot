import { getDb } from './packages/db/dist/index.js';
import dotenv from 'dotenv';
dotenv.config();

const db = await getDb();
const EGG = '0x6a4a8ddec73351c54399a2ca9b7d650a8ac5f5c5c8a17cde5cf6d8a69225ea07::egg::EGG';

const posRes = await db.query('SELECT id, quantity_held FROM positions WHERE token_address = $1', [EGG]);
const pos = posRes.rows[0];
const posId = pos.id;

// Total token qty from all buy fills minus sell fills
const buysRes = await db.query("SELECT SUM(amount::numeric) as total FROM fills WHERE position_id = $1 AND side = 'buy'", [posId]);
const sellsRes = await db.query("SELECT SUM(amount::numeric) as total FROM fills WHERE position_id = $1 AND side = 'sell'", [posId]);

const buyTotal = BigInt(buysRes.rows[0].total?.split('.')[0] || '0');
const sellTotal = BigInt(sellsRes.rows[0].total?.split('.')[0] || '0');
const correctQty = buyTotal - sellTotal;

console.log('Buy total (raw):', buyTotal.toString());
console.log('Sell total (raw):', sellTotal.toString());
console.log('Correct qty (raw):', correctQty.toString());
console.log('Correct qty (6dec):', (Number(correctQty) / 1e6).toFixed(6), 'EGG');
console.log('Current position qty:', pos.quantity_held);
console.log('Current position qty (6dec):', (parseFloat(pos.quantity_held) / 1e6).toFixed(6), 'EGG');

// Fix: set position qty to what fills say it should be
await db.query('UPDATE positions SET quantity_held = $1 WHERE id = $2', [correctQty.toString(), posId]);
console.log(`\nFixed! position.quantity_held = ${correctQty} (${(Number(correctQty)/1e6).toFixed(2)} EGG)`);

// Also verify avg_entry_price
const posAfter = await db.query('SELECT avg_entry_price, quantity_held FROM positions WHERE id = $1', [posId]);
const p = posAfter.rows[0];
const qtyHuman = Number(BigInt(p.quantity_held)) / 1e6;
const entryPrice = parseFloat(p.avg_entry_price);
const valueAtEntry = qtyHuman * entryPrice;
console.log(`Value at entry = ${qtyHuman.toFixed(2)} EGG × ${entryPrice} SUI = ${valueAtEntry.toFixed(4)} SUI`);

process.exit(0);
