/**
 * In-app protection for the API (Railway has no firewall in front of it).
 *
 * 1. Blocks IPs that behave like an attack: repeated failed sign-ins, forbidden requests, probing
 *    for hidden pages, or hammering past rate limits. A blocked IP gets 429 on every API route for
 *    an hour (a day if it comes back). Telegram's webhook, health checks and static files are never
 *    blocked or counted.
 * 2. Rate limits for sign-in, trading, withdrawal and profile routes, per IP and per signed-in
 *    session (many mobile users share one carrier IP, so IP limits are generous and session
 *    limits are the tight ones).
 * 3. Tells the admins in Telegram when an IP is blocked or one IP signs in to many accounts.
 *
 * Blocks are kept in Redis too, so a restart does not let a blocked IP back in.
 */
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { createLogger, createRedis, type RedisClient } from '@racerbot/shared';

const logger = createLogger('abuse-shield');

export interface ShieldConfig {
  strikeWindowMs: number;
  strikesToBlock: number;
  blockMs: number;
  /** Block length for an IP blocked again within a day */
  repeatBlockMs: number;
  /** Distinct accounts one IP may use within the hour before the admins hear about it */
  accountsPerIpAlert: number;
}

export const DEFAULT_SHIELD_CONFIG: ShieldConfig = {
  strikeWindowMs: 10 * 60 * 1000,
  strikesToBlock: 40,
  blockMs: 60 * 60 * 1000,
  repeatBlockMs: 24 * 60 * 60 * 1000,
  accountsPerIpAlert: 4,
};

interface RouteLimit {
  name: string;
  match: RegExp;
  methods?: string[];
  windowMs: number;
  /** Per client IP (generous: carrier NAT puts many users behind one IP) */
  perIp: number;
  /** Per signed-in session (the Authorization header), when there is one */
  perSession?: number;
}

const MIN = 60 * 1000;
export const ROUTE_LIMITS: RouteLimit[] = [
  { name: 'sign-in start', match: /^\/auth\/session\/create$/, methods: ['POST'], windowMs: MIN, perIp: 20 },
  { name: 'sign-in poll', match: /^\/auth\/(session|telegram\/status)\/[^/]+$/, methods: ['GET'], windowMs: MIN, perIp: 120 },
  { name: 'wallet sign-in', match: /^\/auth\/(wallet\/challenge|wallet-login)$/, methods: ['POST'], windowMs: 10 * MIN, perIp: 40 },
  { name: 'mini app sign-in', match: /^\/auth\/tma$/, methods: ['POST'], windowMs: 10 * MIN, perIp: 60 },
  { name: 'code sign-in', match: /^\/auth\/telegram\/(request-verification|verify-code)$/, methods: ['POST'], windowMs: 10 * MIN, perIp: 10 },
  {
    name: 'trading',
    match: /^\/(alpha\/trade(\/execute)?|alpha\/creator\/signal|alpha\/copy-trade|alpha\/keys\/buy|fleet\/(bundle-buy|bundle-sell|deploy|distribute|sweep))$/,
    methods: ['POST'], windowMs: MIN, perIp: 120, perSession: 30,
  },
  {
    name: 'withdrawal',
    match: /^\/alpha\/(withdraw\/send|confidential\/withdraw|vault\/(withdraw|refund))$/,
    methods: ['POST'], windowMs: 10 * MIN, perIp: 30, perSession: 10,
  },
  { name: 'wallet link', match: /^\/wallet\/link-selector$/, methods: ['POST'], windowMs: 10 * MIN, perIp: 20, perSession: 10 },
  {
    name: 'profile',
    match: /^\/(alpha\/creator\/profile|user\/profile|user\/username)$/,
    methods: ['POST'], windowMs: 60 * MIN, perIp: 60, perSession: 20,
  },
];

/** Paths that are never counted or blocked: Telegram's webhook, health checks, static files */
function exempt(path: string): boolean {
  return (
    path === '/telegram-webhook' ||
    path === '/health' ||
    path === '/favicon.ico' ||
    path.startsWith('/assets/')
  );
}

/** Routes are mounted both at / and /api: compare without the /api prefix */
export function normalizePath(path: string): string {
  const p = (path || '/').split('?')[0];
  return p === '/api' ? '/' : p.startsWith('/api/') ? p.slice(4) : p;
}

const isAuthPath = (p: string) => p.startsWith('/auth/');

/** Whether a finished request counts against its IP */
export function isStrike(method: string, path: string, status: number): boolean {
  if (exempt(path)) return false;
  if (status === 403 || status === 429) return true;
  if (status === 404) return true; // probing for pages that do not exist
  // failed sign-ins, and any use of the closed username-code sign-in (410)
  if (isAuthPath(path) && (status === 400 || status === 401 || status === 410)) return true;
  if (status === 401 && method !== 'GET' && method !== 'HEAD') return true; // writes without a valid session
  return false;
}

const sessionKey = (req: Request) => {
  const auth = String(req.headers.authorization || '');
  return auth ? crypto.createHash('sha256').update(auth).digest('hex').slice(0, 24) : '';
};

/** On Railway, the edge sets X-Real-IP to the client's address (and overwrites anything a client sends) */
const ON_RAILWAY = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);

/**
 * The client's IP. Behind Railway, req.ip (last X-Forwarded-For hop) can be one of several edge
 * proxies, which spread one client over a few "IPs" and let it slip past per-IP limits.
 */
export function clientIp(req: Request | any, onRailway = ON_RAILWAY): string {
  const real = onRailway ? String(req?.headers?.['x-real-ip'] || '').trim() : '';
  return real || req?.ip || 'unknown';
}

type Alert = (html: string) => Promise<void> | void;

export class AbuseShield {
  private strikes = new Map<string, number[]>();
  private blocks = new Map<string, number>();
  /** ip -> time of its last block, to lengthen repeat blocks */
  private lastBlocked = new Map<string, number>();
  private hits = new Map<string, number[]>();
  private accountsByIp = new Map<string, Map<string, number>>();
  private alertedAt = new Map<string, number>();
  private recentPaths = new Map<string, string[]>();
  private redis: RedisClient | null = null;

  constructor(
    private readonly config: ShieldConfig = DEFAULT_SHIELD_CONFIG,
    private readonly alert: Alert = () => {},
    redisUrl?: string,
    private readonly now: () => number = Date.now,
  ) {
    if (redisUrl) {
      try {
        this.redis = createRedis(redisUrl);
      } catch (err: any) {
        logger.warn(`Redis unavailable for the abuse shield, blocks are in memory only: ${err?.message}`);
      }
    }
  }

  /** Loads blocks saved before a restart */
  async load(): Promise<void> {
    if (!this.redis) return;
    const saved = await this.redis.hgetall('abuse:blocks').catch(() => null);
    for (const [ip, until] of Object.entries(saved || {})) {
      if (Number(until) > this.now()) this.blocks.set(ip, Number(until));
    }
    if (this.blocks.size) logger.info(`Abuse shield: ${this.blocks.size} IP block(s) restored`);
  }

  private trim(map: Map<string, unknown>, max = 50_000): void {
    if (map.size > max) map.clear();
  }

  blockedUntil(ip: string): number {
    const until = this.blocks.get(ip) ?? 0;
    if (until && until <= this.now()) {
      this.blocks.delete(ip);
      return 0;
    }
    return until;
  }

  async block(ip: string, reason: string): Promise<number> {
    const now = this.now();
    const repeat = (this.lastBlocked.get(ip) ?? 0) > now - 24 * 60 * 60 * 1000;
    const until = now + (repeat ? this.config.repeatBlockMs : this.config.blockMs);
    this.blocks.set(ip, until);
    this.lastBlocked.set(ip, now);
    this.strikes.delete(ip);
    await this.saveBlocks();
    const paths = (this.recentPaths.get(ip) || []).slice(-6).join(', ');
    logger.warn(`[SHIELD] Blocked ${ip} until ${new Date(until).toISOString()}: ${reason}`);
    await this.alertOnce(`block:${ip}`,
      `🛡 <b>Blocked an IP</b>\n\n<code>${esc(ip)}</code> is blocked for ${repeat ? '24 hours (repeat offender)' : '1 hour'}.\n` +
      `Reason: ${esc(reason)}\n` + (paths ? `Recent requests: <code>${esc(paths)}</code>\n` : '') +
      `\nUnblock with <code>/unblockip ${esc(ip)}</code> if this was a real user.`);
    return until;
  }

  async unblock(ip: string): Promise<boolean> {
    const had = this.blocks.delete(ip);
    this.strikes.delete(ip);
    this.lastBlocked.delete(ip);
    await this.saveBlocks();
    return had;
  }

  listBlocks(): { ip: string; until: number }[] {
    return [...this.blocks.entries()].filter(([, u]) => u > this.now()).map(([ip, until]) => ({ ip, until }));
  }

  private async saveBlocks(): Promise<void> {
    if (!this.redis) return;
    await this.redis.del('abuse:blocks').catch(() => {});
    const live = Object.fromEntries(this.listBlocks().map(b => [b.ip, String(b.until)]));
    if (Object.keys(live).length) await this.redis.hset('abuse:blocks', live).catch(() => {});
  }

  /** Records a suspicious request; blocks the IP once it has too many */
  async strike(ip: string, why: string): Promise<void> {
    if (!ip || ip === 'unknown') return;
    const now = this.now();
    this.trim(this.strikes);
    const list = (this.strikes.get(ip) || []).filter(t => now - t < this.config.strikeWindowMs);
    list.push(now);
    this.strikes.set(ip, list);
    if (list.length >= this.config.strikesToBlock && !this.blockedUntil(ip)) {
      await this.block(ip, `${list.length} suspicious requests in ${Math.round(this.config.strikeWindowMs / 60000)} min (last: ${why})`);
    }
  }

  /** Counts a request against a limit; true if it is over */
  overLimit(key: string, windowMs: number, max: number): boolean {
    const now = this.now();
    this.trim(this.hits);
    const list = (this.hits.get(key) || []).filter(t => now - t < windowMs);
    if (list.length >= max) {
      this.hits.set(key, list);
      return true;
    }
    list.push(now);
    this.hits.set(key, list);
    return false;
  }

  /** A signed-in request: tells the admins when one IP uses many different accounts */
  noteAccount(ip: string, userId: string | undefined | null): void {
    if (!ip || !userId || ip === 'unknown') return;
    const now = this.now();
    this.trim(this.accountsByIp);
    const seen = this.accountsByIp.get(ip) || new Map<string, number>();
    seen.set(userId, now);
    for (const [u, t] of seen) if (now - t > 60 * 60 * 1000) seen.delete(u);
    this.accountsByIp.set(ip, seen);
    if (seen.size >= this.config.accountsPerIpAlert) {
      void this.alertOnce(`accounts:${ip}`,
        `👀 <b>One IP, many accounts</b>\n\n<code>${esc(ip)}</code> used <b>${seen.size}</b> different accounts in the last hour.\n` +
        `This can be a shared mobile network, or someone holding other users' sessions. ` +
        `If it looks wrong: <code>/blockip ${esc(ip)}</code>`);
    }
  }

  private async alertOnce(key: string, html: string): Promise<void> {
    const now = this.now();
    if ((this.alertedAt.get(key) ?? 0) > now - 6 * 60 * 60 * 1000) return;
    this.alertedAt.set(key, now);
    try {
      await this.alert(html);
    } catch (err: any) {
      logger.warn(`Admin alert failed: ${err?.message}`);
    }
  }

  /** Express middleware: refuse blocked IPs, apply route limits, and count suspicious results */
  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const path = normalizePath(req.path);
      if (exempt(path)) return next();
      const ip = clientIp(req);

      const until = this.blockedUntil(ip);
      if (until) {
        res.setHeader('Retry-After', String(Math.ceil((until - this.now()) / 1000)));
        res.status(429).json({ error: 'Too many suspicious requests came from your network. Try again later.' });
        return;
      }

      const trail = this.recentPaths.get(ip) || [];
      trail.push(`${req.method} ${path}`.slice(0, 60));
      this.recentPaths.set(ip, trail.slice(-10));
      this.trim(this.recentPaths);

      for (const rule of ROUTE_LIMITS) {
        if (!rule.match.test(path) || (rule.methods && !rule.methods.includes(req.method))) continue;
        const session = sessionKey(req);
        const ipOver = this.overLimit(`ip:${rule.name}:${ip}`, rule.windowMs, rule.perIp);
        const sessionOver = Boolean(rule.perSession && session && this.overLimit(`s:${rule.name}:${session}`, rule.windowMs, rule.perSession));
        if (ipOver || sessionOver) {
          void this.strike(ip, `${rule.name} limit`);
          res.setHeader('Retry-After', String(Math.ceil(rule.windowMs / 1000)));
          res.status(429).json({ error: `Too many ${rule.name} requests. Please wait a little and try again.` });
          return;
        }
        break;
      }

      res.on('finish', () => {
        if (isStrike(req.method, path, res.statusCode)) void this.strike(ip, `${req.method} ${path} → ${res.statusCode}`);
      });
      next();
    };
  }
}

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let shared: AbuseShield | null = null;
/** The process-wide shield (set up in index.ts) */
export function getAbuseShield(): AbuseShield | null {
  return shared;
}
export function setAbuseShield(shield: AbuseShield): void {
  shared = shield;
}
