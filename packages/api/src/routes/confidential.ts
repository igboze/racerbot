/**
 * Confidential wallet routes: private balance, ready pool settings, deposits and withdrawals.
 * Trades themselves go through /alpha/trade with isPrivateTrade (see routes/index.ts).
 */
import type { Router } from 'express';
import { createLogger } from '@racerbot/shared';
import { getConfidentialAccount, listUserExecutors, updateConfidentialSettings, type UserRecord } from '@racerbot/db';
import {
  EXECUTORS_ENABLED,
  POOL_LIMITS,
  confidentialOverview,
  depositFromWallet,
  ensureConfidentialAccount,
  isExternalWallet,
  poolSizesForTotal,
  quoteCrossChainDeposit,
  quoteWalletDeposit,
  refillPool,
  submitWalletDeposit,
  withdrawPrivate,
  WalletNeedsNearError,
} from '../executorPool.js';
import { verifiedUser, unprovenWalletClaim } from './verifiedUser.js';
import { buildRecoveryKit } from '../recoveryKit.js';
import { generateQrBuffer, generateWalletDeepLink, getTokenByKey, SUPPORTED_CHAINS, unitsToRaw } from '../multichainDeposit.js';

const logger = createLogger('confidential-routes');
function nearToYocto(n: unknown): bigint | null {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  return BigInt(Math.round(v * 1e6)) * 10n ** 18n;
}

const toNear = (y: bigint) => Number(y / 10n ** 18n) / 1e6;
const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$|^[0-9a-f]{64}$/;

export function registerConfidentialRoutes(router: Router): void {
  const authed = async (req: any, res: any, allowClaimForRead = false): Promise<UserRecord | null> => {
    let user = await verifiedUser(req).catch(() => null);
    if (!user?.id && allowClaimForRead && (req.method === 'GET' || req.method === 'HEAD')) {
      const claim = unprovenWalletClaim(req);
      if (claim) {
        const { getUserBySubaccount, getUserBySolanaAddress, getUserByEvmAddress } = await import('@racerbot/db');
        user = (await getUserBySubaccount(claim).catch(() => null)) ||
               (await getUserByEvmAddress(claim).catch(() => null)) ||
               (await getUserBySolanaAddress(claim).catch(() => null));
      }
    }
    if (!user?.id) {
      res.status(401).json({ error: 'Sign in with Telegram, or connect your wallet and approve the sign-in message, to use private trading.' });
      return null;
    }
    // Private balances pay out to this account on NEAR (an EVM address is a valid NEAR account; a Solana one is not)
    if (!user.subaccount_id || !NEAR_ACCOUNT.test(user.subaccount_id)) {
      res.status(400).json({ error: 'Private trading pays out to a NEAR account. Connect a NEAR or EVM wallet, or sign in with Telegram, to use it.' });
      return null;
    }
    return user;
  };

  router.get('/alpha/confidential', async (req, res) => {
    try {
      const user = await authed(req, res, true);
      if (!user) return;
      res.json({ success: true, ...(await confidentialOverview(user)) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to load the confidential wallet' });
    }
  });

  /**
   * Pool settings. `poolTotalNear` sets the ready pool (default 5 NEAR as 5 × 1 NEAR); `poolSizesNear`
   * sets an explicit mix instead. Each executor is at least 0.1 NEAR; the total is capped at 100 NEAR.
   */
  router.post('/alpha/confidential/settings', async (req, res) => {
    try {
      const user = await authed(req, res);
      if (!user) return;
      await ensureConfidentialAccount(user);
      const b = req.body || {};
      let sizes: bigint[] | undefined;
      if (Array.isArray(b.poolSizesNear)) {
        sizes = b.poolSizesNear.map(nearToYocto);
        if (sizes!.some(s => s === null || s < POOL_LIMITS.min)) {
          res.status(400).json({ error: `Each executor must hold at least ${toNear(POOL_LIMITS.min)} NEAR.` });
          return;
        }
      } else if (b.poolTotalNear !== undefined) {
        const total = nearToYocto(b.poolTotalNear);
        if (!total || total < POOL_LIMITS.min) {
          res.status(400).json({ error: `The pool must be at least ${toNear(POOL_LIMITS.min)} NEAR.` });
          return;
        }
        sizes = poolSizesForTotal(total).map(BigInt);
      }
      const total = sizes?.reduce((s, x) => s + x, 0n);
      if (total !== undefined && total > POOL_LIMITS.hardCap) {
        res.status(400).json({ error: `The pool can hold at most ${toNear(POOL_LIMITS.hardCap)} NEAR.` });
        return;
      }
      if (sizes && sizes.length > 20) {
        res.status(400).json({ error: 'At most 20 ready executors.' });
        return;
      }
      const buyMode = ['single', 'split', 'fleet'].includes(b.buyMode) ? b.buyMode : undefined;
      const stagger = b.fleetStaggerMaxSec === undefined ? undefined : Math.min(10, Math.max(0, Math.round(Number(b.fleetStaggerMaxSec) || 0)));
      const updated = await updateConfidentialSettings(user.id, {
        pool_sizes: sizes?.map(String),
        pool_cap_yocto: total?.toString(),
        auto_refill: typeof b.autoRefill === 'boolean' ? b.autoRefill : undefined,
        buy_mode: buyMode,
        fleet_stagger_max_sec: stagger,
        round_returns: typeof b.roundReturns === 'boolean' ? b.roundReturns : undefined,
        enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
      });
      if (updated) void refillPool(updated).catch(e => logger.warn(`Refill after settings failed: ${e?.message}`));
      res.json({ success: true, ...(await confidentialOverview(user)) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to save settings' });
    }
  });

  router.post('/alpha/confidential/deposit', async (req, res) => {
    try {
      const user = await authed(req, res);
      if (!user) return;
      const amount = nearToYocto(req.body?.amountNear);
      if (!amount || amount < POOL_LIMITS.min) {
        res.status(400).json({ error: `Deposit at least ${toNear(POOL_LIMITS.min)} NEAR.` });
        return;
      }
      // The source is the user's choice: their RacerBot wallet (RacerBot signs) or their connected NEAR
      // wallet (that wallet signs, and refunds go back to it). Either way it lands in the private balance.
      const source = req.body?.source === 'connected_wallet' || req.body?.fromConnectedWallet === true || isExternalWallet(user)
        ? 'connected_wallet' : 'racer_wallet';
      if (source === 'connected_wallet') {
        const fromAccount = String(req.body?.fromAccount || (isExternalWallet(user) ? user.subaccount_id : '')).trim().toLowerCase();
        const quote = await quoteWalletDeposit(user, amount, fromAccount);
        res.json({ success: true, requiresWalletSignature: true, ...quote, fromAccount, amountNear: toNear(amount) });
        return;
      }
      // RacerBot wallet: if it cannot cover the deposit, say so with a code so the page can suggest the other sources
      const result = await depositFromWallet(user, amount);
      res.json({ success: true, ...result, amountNear: toNear(amount), message: 'Deposit sent. It reaches your private balance in about 20 seconds.' });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Deposit failed', ...(err instanceof WalletNeedsNearError ? { code: err.code } : {}) });
    }
  });

  /** After the user's wallet signed a quoted deposit: hand 1Click the transaction so it settles straight away */
  router.post('/alpha/confidential/deposit/submit', async (req, res) => {
    try {
      const user = await authed(req, res);
      if (!user) return;
      const { depositAddress, txHash } = req.body || {};
      if (typeof depositAddress !== 'string' || typeof txHash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(txHash)) {
        res.status(400).json({ error: 'depositAddress and a transaction hash are required.' });
        return;
      }
      await submitWalletDeposit(user, depositAddress, txHash);
      res.json({ success: true, message: 'Deposit sent. It reaches your private balance in about 20 seconds.' });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Could not record the deposit' });
    }
  });

  /**
   * Deposit from another chain straight into the private balance. Body: `tokenKey` (from /deposit/tokens)
   * and `amount` in that token's units. Returns the one-time address to send to.
   */
  router.post('/alpha/confidential/deposit/crosschain', async (req, res) => {
    try {
      const user = await authed(req, res);
      if (!user) return;
      const token = getTokenByKey(String(req.body?.tokenKey || ''));
      const amount = Number(req.body?.amount);
      if (!token) {
        res.status(400).json({ error: 'Pick a token to deposit.' });
        return;
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        res.status(400).json({ error: 'Enter an amount to deposit.' });
        return;
      }
      const amountRaw = unitsToRaw(amount, token.decimals);
      const quote = await quoteCrossChainDeposit(user, token.assetId, amountRaw);
      const qr = await generateQrBuffer(quote.depositAddress);
      const chain = SUPPORTED_CHAINS[token.blockchain.toLowerCase()];
      res.json({
        success: true,
        depositAddress: quote.depositAddress,
        depositMemo: quote.depositMemo ?? null,
        chain: chain?.name || token.blockchain,
        symbol: token.symbol,
        amount: String(amount),
        // What a connected wallet must send: native coin, or this token contract, in base units
        sourceChain: token.blockchain.toLowerCase(),
        sourceDecimals: token.decimals,
        sourceContract: token.contractAddress || null,
        sourceAmountRaw: amountRaw,
        expectedNear: toNear(BigInt(quote.amountOut || '0')),
        minNear: toNear(BigInt(quote.minAmountOut || '0')),
        timeEstimateSec: quote.timeEstimate ?? null,
        qrDataUrl: `data:image/png;base64,${qr.toString('base64')}`,
        walletLink: generateWalletDeepLink(token.blockchain, quote.depositAddress, amount) || null,
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Could not create the deposit' });
    }
  });

  router.post('/alpha/confidential/withdraw', async (req, res) => {
    try {
      const user = await authed(req, res);
      if (!user) return;
      const amount = nearToYocto(req.body?.amountNear);
      if (!amount) {
        res.status(400).json({ error: 'Enter an amount to withdraw.' });
        return;
      }
      const destination = typeof req.body?.destination === 'string' && req.body.destination.trim() ? req.body.destination.trim() : undefined;
      if (destination && !NEAR_ACCOUNT.test(destination)) {
        res.status(400).json({ error: 'That is not a valid NEAR account.' });
        return;
      }
      const result = await withdrawPrivate(user, amount, destination);
      res.json({ success: true, ...result, amountNear: toNear(amount), message: 'Withdrawal sent. It arrives in about 15 seconds.' });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Withdrawal failed' });
    }
  });

  /**
   * The user's recovery kit: their salt and ready-made calls to get money out of
   * their executors without RacerBot. Only the signed-in owner gets it.
   */
  router.get('/alpha/confidential/recovery-kit', async (req, res) => {
    try {
      const user = await authed(req, res);
      if (!user) return;
      const acct = await getConfidentialAccount(user.id);
      if (!acct) {
        res.status(404).json({ error: 'No private balance yet, so there is nothing to recover.' });
        return;
      }
      const executors = await listUserExecutors(acct.user_id, ['creating', 'funding', 'ready', 'claimed', 'open', 'exiting', 'exited', 'failed']);
      const kit = buildRecoveryKit({ payoutAddress: acct.payout_address, salt: acct.owner_salt, executors });
      res.set('Cache-Control', 'private, no-store');
      res.set('Content-Disposition', 'attachment; filename="racerbot-recovery-kit.json"');
      res.json(kit);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Could not build the recovery kit' });
    }
  });

  router.post('/alpha/confidential/refill', async (req, res) => {
    try {
      const user = await authed(req, res);
      if (!user) return;
      const acct = await getConfidentialAccount(user.id);
      if (!acct) {
        res.status(400).json({ error: 'Deposit to your private balance first.' });
        return;
      }
      const started = await refillPool(acct);
      res.json({ success: true, started });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Refill failed' });
    }
  });
}

