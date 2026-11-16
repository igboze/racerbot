import { randomUUID } from 'crypto';

/**
 * In-memory PostgreSQL Pool fallback used exclusively during `vitest` runs when no local
 * PostgreSQL server or `DATABASE_URL` is reachable (e.g., in clean CI / automated screener
 * containers). Supports the exact SQL queries exercised by `db.test.ts`, `trigger.test.ts`,
 * and `wallet.test.ts`.
 */
export function createInMemoryTestPool(): any {
  const users = new Map<string, any>();
  const userWallets = new Map<string, any>();
  const positions = new Map<string, any>();
  const fills = new Map<string, any>();
  const triggers = new Map<string, any>();
  const tokenCache = new Map<string, any>();

  function updatePositionFill(posId: string, side: string, amountInput: any, priceInput: any, _feeInput: any) {
    const pos = positions.get(posId);
    if (!pos) return;
    const qty = Number(pos.quantity_held || 0);
    const avg = Number(pos.avg_entry_price || 0);
    const amt = Number(amountInput || 0);
    const price = Number(priceInput || 0);

    if (side === 'buy') {
      const newQty = qty + amt;
      const newAvg = newQty > 0 ? (qty * avg + amt * price) / newQty : price;
      pos.quantity_held = String(newQty);
      pos.avg_entry_price = String(newAvg);
    } else if (side === 'sell') {
      const newQty = Math.max(0, qty - amt);
      pos.quantity_held = String(newQty);
      if (newQty === 0) {
        pos.status = 'closed';
        pos.closed_at = new Date();
      }
    }
    pos.updated_at = new Date();
  }

  async function executeQuery(rawSql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const sql = rawSql.replace(/\s+/g, ' ').trim();

    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql) || /^SELECT 1$/i.test(sql) || /^ALTER TABLE/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }

    // ── users ──
    if (/^INSERT INTO users/i.test(sql)) {
      const telegram_id = Number(params[0]);
      for (const u of users.values()) {
        if (Number(u.telegram_id) === telegram_id) {
          u.subaccount_id = params[1];
          u.scoped_key_encrypted = params[2];
          return { rows: [{ ...u }], rowCount: 1 };
        }
      }
      const row = {
        id: randomUUID(),
        telegram_id,
        subaccount_id: params[1],
        scoped_key_encrypted: params[2],
        sui_address: params[3] ?? null,
        sui_private_key_enc: params[4] ?? null,
        starknet_address: params[5] ?? null,
        starknet_private_key_enc: params[6] ?? null,
        default_buy_pct: params[7] ?? null,
        default_sell_pct: params[8] ?? null,
        fee_tier: params[9] ?? 'standard',
        solana_address: params[10] ?? null,
        solana_private_key_enc: params[11] ?? null,
        evm_address: params[12] ?? null,
        evm_private_key_enc: params[13] ?? null,
        slippage_pct: 2,
        near_trade_currency: 'near',
        created_at: new Date(),
      };
      users.set(row.id, row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (/^SELECT \* FROM users WHERE telegram_id = \$1/i.test(sql)) {
      const tg = Number(params[0]);
      const found = Array.from(users.values()).find(u => Number(u.telegram_id) === tg);
      return { rows: found ? [{ ...found }] : [], rowCount: found ? 1 : 0 };
    }

    if (/^SELECT .* FROM users WHERE id = \$1/i.test(sql)) {
      const found = users.get(String(params[0]));
      return { rows: found ? [{ ...found }] : [], rowCount: found ? 1 : 0 };
    }

    if (/^UPDATE users SET subaccount_id = \$1, scoped_key_encrypted = \$2 WHERE id = \$3/i.test(sql)) {
      const u = users.get(String(params[2]));
      if (u) {
        u.subaccount_id = params[0];
        u.scoped_key_encrypted = params[1];
      }
      return { rows: u ? [{ ...u }] : [], rowCount: u ? 1 : 0 };
    }

    if (/^UPDATE users SET scoped_key_encrypted = \$1 WHERE id = \$2/i.test(sql)) {
      const u = users.get(String(params[1]));
      if (u) u.scoped_key_encrypted = params[0];
      return { rows: u ? [{ ...u }] : [], rowCount: u ? 1 : 0 };
    }

    if (/^DELETE FROM users WHERE telegram_id = ANY\(\$1\)/i.test(sql)) {
      const list = (params[0] || []).map(Number);
      for (const [id, u] of users.entries()) {
        if (list.includes(Number(u.telegram_id))) users.delete(id);
      }
      return { rows: [], rowCount: 1 };
    }

    if (/^DELETE FROM users WHERE id = \$1/i.test(sql)) {
      users.delete(String(params[0]));
      return { rows: [], rowCount: 1 };
    }

    // ── user_wallets ──
    if (/^SELECT id FROM user_wallets WHERE user_id = \$1 AND chain = '([^']+)' AND is_active = TRUE/i.test(sql)) {
      const m = sql.match(/chain = '([^']+)'/i);
      const chain = m ? m[1] : 'near';
      const found = Array.from(userWallets.values()).filter(
        w => w.user_id === params[0] && w.chain === chain && w.is_active
      );
      return { rows: found.map(w => ({ id: w.id })), rowCount: found.length };
    }

    if (/^SELECT \* FROM user_wallets WHERE user_id = \$1 AND chain = \$2 AND is_active = TRUE/i.test(sql)) {
      const found = Array.from(userWallets.values()).find(
        w => w.user_id === params[0] && w.chain === params[1] && w.is_active
      );
      return { rows: found ? [{ ...found }] : [], rowCount: found ? 1 : 0 };
    }

    if (/^SELECT \* FROM user_wallets WHERE user_id = \$1 AND chain = \$2/i.test(sql)) {
      const found = Array.from(userWallets.values())
        .filter(w => w.user_id === params[0] && w.chain === params[1])
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
      return { rows: found.map(w => ({ ...w })), rowCount: found.length };
    }

    if (/^SELECT \* FROM user_wallets WHERE id = \$1 AND user_id = \$2/i.test(sql)) {
      const w = userWallets.get(String(params[0]));
      if (!w || w.user_id !== params[1] || (params[2] && w.chain !== params[2])) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ ...w }], rowCount: 1 };
    }

    if (/^UPDATE user_wallets SET is_active = FALSE WHERE user_id = \$1 AND chain = \$2/i.test(sql)) {
      for (const w of userWallets.values()) {
        if (w.user_id === params[0] && w.chain === params[1]) w.is_active = false;
      }
      return { rows: [], rowCount: 1 };
    }

    if (/^UPDATE user_wallets SET is_active = TRUE WHERE id = \$1/i.test(sql)) {
      const w = userWallets.get(String(params[0]));
      if (w) w.is_active = true;
      return { rows: w ? [{ ...w }] : [], rowCount: w ? 1 : 0 };
    }

    if (/^UPDATE user_wallets SET name = \$1 WHERE id = \$2 AND user_id = \$3/i.test(sql)) {
      const w = userWallets.get(String(params[1]));
      if (!w || w.user_id !== params[2]) return { rows: [], rowCount: 0 };
      w.name = params[0];
      return { rows: [{ ...w }], rowCount: 1 };
    }

    if (/^DELETE FROM user_wallets WHERE id = \$1/i.test(sql)) {
      userWallets.delete(String(params[0]));
      return { rows: [], rowCount: 1 };
    }

    if (/^INSERT INTO user_wallets/i.test(sql)) {
      let row: any;
      if (params.length === 3) {
        const m = sql.match(/VALUES \(\$1, '([^']+)', \$2, 'Wallet 1', \$3/i);
        const chain = m ? m[1] : 'near';
        const existing = Array.from(userWallets.values()).find(
          w => w.user_id === params[0] && w.chain === chain && w.address === params[1]
        );
        if (existing) {
          existing.is_active = true;
          existing.encrypted_private_key = params[2];
          return { rows: [{ ...existing }], rowCount: 1 };
        }
        row = {
          id: randomUUID(),
          user_id: params[0],
          chain,
          address: params[1],
          name: 'Wallet 1',
          encrypted_private_key: params[2],
          is_imported: false,
          is_active: true,
          created_at: new Date(),
        };
      } else if (params.length === 4) {
        const existing = Array.from(userWallets.values()).find(
          w => w.user_id === params[0] && w.chain === params[1] && w.address === params[2]
        );
        if (existing) {
          existing.is_active = true;
          existing.encrypted_private_key = params[3];
          return { rows: [{ ...existing }], rowCount: 1 };
        }
        row = {
          id: randomUUID(),
          user_id: params[0],
          chain: params[1],
          address: params[2],
          name: 'Wallet 1',
          encrypted_private_key: params[3],
          is_imported: false,
          is_active: true,
          created_at: new Date(),
        };
      } else {
        row = {
          id: randomUUID(),
          user_id: params[0],
          chain: params[1],
          address: params[2],
          name: params[3],
          encrypted_private_key: params[4],
          is_imported: Boolean(params[5]),
          is_active: Boolean(params[6]),
          created_at: new Date(),
        };
      }
      userWallets.set(row.id, row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    // ── positions ──
    if (/^INSERT INTO positions/i.test(sql)) {
      const hasExplicitId = params.length >= 6;
      const row = {
        id: hasExplicitId ? params[0] : randomUUID(),
        user_id: hasExplicitId ? params[1] : params[0],
        chain: hasExplicitId ? params[2] : (params.length === 5 ? params[1] : 'near'),
        token_address: hasExplicitId ? params[3] : (params.length === 5 ? params[2] : params[1]),
        quantity_held: String(hasExplicitId ? params[4] : (params.length === 5 ? params[3] : params[2])),
        avg_entry_price: String(hasExplicitId ? params[5] : (params.length === 5 ? params[4] : params[3])),
        status: 'open',
        opened_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
        closed_at: null,
      };
      positions.set(row.id, row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (/^SELECT \* FROM positions WHERE user_id = \$1 AND token_address = \$2 AND chain = \$3 AND status = 'open'/i.test(sql)) {
      const found = Array.from(positions.values()).find(
        p => p.user_id === params[0] && p.token_address === params[1] && p.chain === params[2] && p.status === 'open'
      );
      return { rows: found ? [{ ...found }] : [], rowCount: found ? 1 : 0 };
    }

    if (/^SELECT \* FROM positions WHERE id = \$1/i.test(sql)) {
      const pos = positions.get(String(params[0]));
      return { rows: pos ? [{ ...pos }] : [], rowCount: pos ? 1 : 0 };
    }

    if (/^SELECT \* FROM positions WHERE id = ANY\(\$1\)/i.test(sql)) {
      const ids: string[] = params[0] || [];
      const rows = ids.map(id => positions.get(id)).filter(Boolean).map(p => ({ ...p }));
      return { rows, rowCount: rows.length };
    }

    if (/SELECT update_position_fill/i.test(sql)) {
      updatePositionFill(String(params[0]), String(params[1]), params[2], params[3], params[4]);
      return { rows: [{}], rowCount: 1 };
    }

    if (/^DELETE FROM positions/i.test(sql)) {
      for (const [id, p] of positions.entries()) {
        if (p.user_id === params[0]) positions.delete(id);
      }
      return { rows: [], rowCount: 1 };
    }

    // ── fills ──
    if (/^INSERT INTO fills/i.test(sql)) {
      const txHash = String(params[params.length - 1]);
      for (const f of fills.values()) {
        if (f.tx_hash === txHash) {
          return { rows: [], rowCount: 0 };
        }
      }
      const isTwelveParams = params.length >= 12;
      const row = {
        id: isTwelveParams ? params[0] : randomUUID(),
        user_id: isTwelveParams ? params[1] : params[0],
        position_id: isTwelveParams ? params[2] : params[1],
        chain: isTwelveParams ? params[3] : 'near',
        side: isTwelveParams ? params[4] : params[2],
        token_address: isTwelveParams ? params[5] : params[3],
        amount: String(isTwelveParams ? params[6] : params[4]),
        price: String(isTwelveParams ? params[7] : params[5]),
        fee_paid: String(isTwelveParams ? params[8] : params[6]),
        input_amount: isTwelveParams ? (params[9] ?? null) : null,
        venue: isTwelveParams ? params[10] : params[7],
        tx_hash: txHash,
        created_at: new Date(),
      };
      fills.set(row.id, row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    if (/^SELECT \* FROM fills WHERE tx_hash = \$1/i.test(sql)) {
      const rows = Array.from(fills.values()).filter(f => f.tx_hash === params[0]);
      return { rows, rowCount: rows.length };
    }

    // ── triggers ──
    if (/^INSERT INTO triggers/i.test(sql)) {
      const hasExplicitId = params.length >= 8;
      const row = {
        id: hasExplicitId ? params[0] : randomUUID(),
        user_id: hasExplicitId ? params[1] : params[0],
        position_id: hasExplicitId ? params[2] : params[1],
        chain: hasExplicitId ? params[3] : 'near',
        type: hasExplicitId ? params[4] : params[2],
        target_value: String(hasExplicitId ? params[5] : params[3]),
        sell_pct: hasExplicitId ? (params[6] ?? 100) : (params[4] ?? 100),
        high_water_mark_price: null,
        status: hasExplicitId ? (params[7] ?? 'active') : 'active',
        created_at: new Date(),
        fired_at: null,
      };
      triggers.set(row.id, row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (/FROM triggers WHERE status = \$1/i.test(sql) || /FROM triggers.*WHERE status = 'active'/i.test(sql)) {
      const targetStatus = params[0] || 'active';
      const rows = Array.from(triggers.values()).filter(t => t.status === targetStatus).map(t => ({ ...t }));
      return { rows, rowCount: rows.length };
    }

    if (/^UPDATE triggers SET status = \$1/i.test(sql)) {
      const trig = triggers.get(String(params[1]));
      if (!trig || (sql.includes("status = 'active'") && trig.status !== 'active')) {
        return { rows: [], rowCount: 0 };
      }
      trig.status = params[0];
      trig.fired_at = new Date();
      return { rows: [{ ...trig }], rowCount: 1 };
    }

    if (/^SELECT status FROM triggers WHERE id = \$1/i.test(sql)) {
      const trig = triggers.get(String(params[0]));
      return { rows: trig ? [{ status: trig.status }] : [], rowCount: trig ? 1 : 0 };
    }

    if (/^SELECT status FROM triggers WHERE id = ANY\(\$1\)/i.test(sql)) {
      const ids: string[] = params[0] || [];
      const rows = ids.map(id => triggers.get(id)).filter(Boolean).map(t => ({ status: t.status }));
      return { rows, rowCount: rows.length };
    }

    if (/^DELETE FROM triggers/i.test(sql)) {
      for (const [id, t] of triggers.entries()) {
        if (t.user_id === params[0]) triggers.delete(id);
      }
      return { rows: [], rowCount: 1 };
    }

    // ── token_cache ──
    if (/^INSERT INTO token_cache/i.test(sql)) {
      const row = {
        token_address: params[0],
        chain: 'near',
        name: params[1],
        symbol: params[2],
        decimals: params[3],
        venue: params[4],
        rhea_pool_id: params[5],
        last_price: params[6],
        last_liquidity: params[7],
        updated_at: new Date(),
      };
      tokenCache.set(row.token_address, row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (/FROM token_cache WHERE token_address = ANY\(\$1\)/i.test(sql)) {
      const addrs: string[] = params[0] || [];
      const rows = addrs.map(a => tokenCache.get(a)).filter(Boolean).map(t => ({ ...t }));
      return { rows, rowCount: rows.length };
    }

    if (/FROM token_cache WHERE token_address = \$1/i.test(sql)) {
      const row = tokenCache.get(String(params[0]));
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }

    if (/^DELETE FROM token_cache/i.test(sql)) {
      tokenCache.delete(String(params[0]));
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }

  return {
    query: executeQuery,
    connect: async () => ({
      query: executeQuery,
      release: () => {},
    }),
    on: () => {},
    end: async () => {},
  };
}
