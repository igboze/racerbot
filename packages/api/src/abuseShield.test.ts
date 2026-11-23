import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { AbuseShield, DEFAULT_SHIELD_CONFIG, isStrike, normalizePath, clientIp } from './abuseShield.js';

/** A fake request through the middleware; `status` is what the route would answer */
function makeShield() {
  let t = Date.parse('2026-11-23T09:00:00Z');
  const alerts: string[] = [];
  const shield = new AbuseShield(DEFAULT_SHIELD_CONFIG, (html) => { alerts.push(html); }, undefined, () => t);
  const mw = shield.middleware();
  async function call(ip: string, method: string, path: string, status = 200, auth = ''): Promise<number> {
    const req: any = { ip, method, path, headers: auth ? { authorization: auth } : {} };
    const res: any = new EventEmitter();
    res.statusCode = 0;
    res.setHeader = () => {};
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = () => { res.emit('finish'); return res; };
    let passed = false;
    mw(req, res, () => { passed = true; });
    if (passed) {
      res.statusCode = status;
      res.emit('finish');
    }
    await new Promise((r) => setImmediate(r));
    return res.statusCode;
  }
  return { shield, call, alerts, advance: (ms: number) => { t += ms; } };
}

const ATTACKER = '102.89.68.154';
const USER = '102.89.40.1';

describe('abuse shield', () => {
  it('blocks a script like the one from Nov 2026 within its first burst, and tells the admins', async () => {
    const { call, alerts } = makeShield();
    // What the script did: hammer code sign-in, guess codes, probe hidden pages
    for (let i = 0; i < 12; i++) await call(ATTACKER, 'POST', '/api/auth/telegram/request-verification', 410);
    for (let i = 0; i < 8; i++) await call(ATTACKER, 'POST', '/api/auth/telegram/verify-code', 400);
    for (const p of ['/metrics', '/internal', '/signer/health', '/executor/health', '/health-detailed']) await call(ATTACKER, 'GET', p, 404);
    for (let i = 0; i < 20; i++) await call(ATTACKER, 'POST', '/api/auth/tma', 401);

    expect(await call(ATTACKER, 'GET', '/alpha/tokens', 200)).toBe(429);
    expect(alerts.join('\n')).toContain('Blocked an IP');
    expect(alerts.join('\n')).toContain(ATTACKER);
  });

  it('never blocks Telegram webhooks or health checks', async () => {
    const { call } = makeShield();
    for (let i = 0; i < 100; i++) await call(ATTACKER, 'POST', '/telegram-webhook', 403);
    expect(await call(ATTACKER, 'POST', '/telegram-webhook', 200)).toBe(200);
    expect(await call(ATTACKER, 'GET', '/health', 200)).toBe(200);
  });

  it('leaves a normal logged-out visitor alone', async () => {
    const { call } = makeShield();
    // A browser polling while logged out: GET 401s, sign-in polls every 3 s for 2 minutes
    for (let i = 0; i < 60; i++) await call(USER, 'GET', '/alpha/confidential', 401);
    await call(USER, 'POST', '/api/auth/session/create', 200);
    for (let i = 0; i < 40; i++) await call(USER, 'GET', '/api/auth/session/sess_' + 'a'.repeat(32), 200);
    expect(await call(USER, 'GET', '/alpha/tokens', 200)).toBe(200);
  });

  it('limits trading per session much more tightly than per IP (many users share a carrier IP)', async () => {
    const { call } = makeShield();
    for (let i = 0; i < 30; i++) expect(await call(USER, 'POST', '/alpha/trade/execute', 200, 'Bearer one')).toBe(200);
    expect(await call(USER, 'POST', '/alpha/trade/execute', 200, 'Bearer one')).toBe(429);
    // Someone else on the same carrier IP still trades
    expect(await call(USER, 'POST', '/alpha/trade/execute', 200, 'Bearer two')).toBe(200);
  });

  it('caps withdrawals per session', async () => {
    const { call } = makeShield();
    for (let i = 0; i < 10; i++) await call(USER, 'POST', '/api/alpha/withdraw/send', 200, 'Bearer w');
    expect(await call(USER, 'POST', '/api/alpha/withdraw/send', 200, 'Bearer w')).toBe(429);
  });

  it('blocks expire, come back longer for repeat offenders, and admins can lift them', async () => {
    const { shield, call, advance } = makeShield();
    await shield.block(ATTACKER, 'test');
    expect(await call(ATTACKER, 'GET', '/alpha/tokens')).toBe(429);
    advance(61 * 60 * 1000);
    expect(await call(ATTACKER, 'GET', '/alpha/tokens')).toBe(200);
    const until = await shield.block(ATTACKER, 'again');
    expect(until - Date.parse('2026-11-23T10:01:00Z')).toBeGreaterThanOrEqual(23 * 60 * 60 * 1000);
    expect(await shield.unblock(ATTACKER)).toBe(true);
    expect(await call(ATTACKER, 'GET', '/alpha/tokens')).toBe(200);
  });

  it('tells the admins when one IP uses many accounts', () => {
    const { shield, alerts } = makeShield();
    for (const u of ['stellar', 'quick', 'treasury', 'badguy']) shield.noteAccount(ATTACKER, u);
    expect(alerts.join('\n')).toContain('One IP, many accounts');
  });

  it('takes the client IP from Railway\'s X-Real-IP, not the edge proxy hop', () => {
    const req = { ip: '100.64.0.7', headers: { 'x-real-ip': '102.89.68.154' } };
    expect(clientIp(req, true)).toBe('102.89.68.154');
    // Off Railway nothing sets the header, so a client could fake it: ignore it there
    expect(clientIp(req, false)).toBe('100.64.0.7');
  });

  it('counts the right things', () => {
    expect(normalizePath('/api/auth/tma')).toBe('/auth/tma');
    expect(isStrike('GET', '/alpha/confidential', 401)).toBe(false);
    expect(isStrike('POST', '/alpha/trade/execute', 401)).toBe(true);
    expect(isStrike('POST', '/auth/telegram/verify-code', 400)).toBe(true);
    expect(isStrike('GET', '/assets/logo.png', 404)).toBe(false);
    expect(isStrike('GET', '/metrics', 404)).toBe(true);
  });
});
