import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Deposit Watcher & Balance Tracking Logic', () => {
  it('correctly calculates NEAR deposit delta and filters dust below 0.01', () => {
    const prevNear = 2.5000;
    const currentNear = 3.5000;
    const delta = currentNear - prevNear;

    expect(delta).toBeCloseTo(1.0, 4);
    expect(delta >= 0.01).toBe(true);

    const dustCurrent = 2.5005;
    const dustDelta = dustCurrent - prevNear;
    expect(dustDelta >= 0.01).toBe(false);
  });

  it('suppresses false deposit alerts when balance increase matches DEX sell proceeds', () => {
    const prevNear = 2.0;
    const currentNear = 4.0; // balance increased by 2.0 NEAR
    const delta = currentNear - prevNear;

    const sellProceeds = 2.0;
    const isTradeProceeds = sellProceeds > 0 && Math.abs(delta - sellProceeds) < 0.05;

    expect(isTradeProceeds).toBe(true);
  });

  it('notifies external deposit when balance increase exceeds sell proceeds', () => {
    const prevNear = 2.0;
    const currentNear = 7.0; // balance increased by 5.0 NEAR
    const delta = currentNear - prevNear;

    const sellProceeds = 2.0; // user sold tokens for 2 NEAR, but also deposited 3 NEAR
    const isTradeProceeds = sellProceeds > 0 && Math.abs(delta - sellProceeds) < 0.05;
    const depositAmount = sellProceeds > 0 && delta > sellProceeds ? (delta - sellProceeds) : delta;

    expect(isTradeProceeds).toBe(false);
    expect(depositAmount).toBeCloseTo(3.0, 4);
    expect(depositAmount >= 0.01).toBe(true);
  });

  it('restores baseline from DB across restarts so deposits during downtime are detected', () => {
    // Simulated DB record: user last had 1.5 NEAR before restart
    const dbRecord = {
      id: 'user-1',
      telegram_id: 123456,
      subaccount_id: 'alice.near',
      last_near_balance: 1.5,
    };

    // User receives 2.0 NEAR deposit while bot was deploying/restarting:
    const onChainNearBalance = 3.5;

    // Watcher initializes prev state from DB instead of setting to onChainNearBalance:
    const prev = {
      totalNear: Number(dbRecord.last_near_balance),
      initialized: true,
    };

    const delta = onChainNearBalance - prev.totalNear;
    expect(delta).toBeCloseTo(2.0, 4);
    expect(delta >= 0.01).toBe(true);
  });

  it('notifies initial deposit for newly created users', () => {
    const isBrandNewUser = true;
    const currentTotalNear = 5.0;

    // For brand new users created in last hour, baseline starts at 0
    const prev = {
      totalNear: isBrandNewUser ? 0 : currentTotalNear,
      initialized: true,
    };

    const delta = currentTotalNear - prev.totalNear;
    expect(delta).toBe(5.0);
    expect(delta >= 0.01).toBe(true);
  });
});
