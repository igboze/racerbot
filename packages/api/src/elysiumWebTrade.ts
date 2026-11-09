/**
 * Racer Alpha web trades of Elysium mainnet coins (Kleos, RonsPad and Ascend). The web trade endpoint is NEAR-shaped
 * (`amountNear`); Elysium coins are bought with HYPE, so a buy must say `amountHype` and a sell sells a share
 * of the RacerBot position. Both run through the same executor as the Telegram bot: one Elysium transaction
 * carrying the 1.5% fee and the swap, sent straight to Elysium.
 */
import { getOpenPositions, type UserRecord } from '@racerbot/db';
import { ELYSIUM_MAINNET_EXPLORER_URL, elysiumPadName, isElysiumPadVenue, isKleosTradingEnabled, isValidEvmAddress } from '@racerbot/shared';
import { ensureUserEvmWallet, getTokenInfo, publishSwap } from './wallet.js';
import { sellAtTarget } from './sellHelper.js';

export interface ElysiumWebTradeRequest {
  side: string;
  amountHype?: unknown;
  sellPercent?: unknown;
  slippagePct?: unknown;
}

export interface ElysiumWebTradeResponse {
  status: number;
  body: Record<string, unknown>;
}

const MAX_WEB_BUY_HYPE = 1000;

/** True when `tokenAddress` is an Elysium coin RacerBot trades (a Kleos, RonsPad or Ascend launch) */
export function isElysiumTradeVenue(info: { chain?: string; venue?: string } | null | undefined): boolean {
  return Boolean(info && info.chain === 'elysium' && isElysiumPadVenue(info.venue));
}

/**
 * Runs a web trade when the token is an Elysium coin; returns null for every other token, which the caller
 * trades on its usual NEAR path.
 */
export async function executeWebElysiumTrade(
  user: UserRecord,
  tokenAddress: string,
  req: ElysiumWebTradeRequest
): Promise<ElysiumWebTradeResponse | null> {
  if (!isValidEvmAddress(tokenAddress)) return null;
  const info = await getTokenInfo(tokenAddress).catch(() => null);
  if (!isElysiumTradeVenue(info)) return null;
  const pad = elysiumPadName(info!.venue);
  const fail = (error: string, status = 400): ElysiumWebTradeResponse => ({ status, body: { success: false, chain: 'elysium', error } });

  if (!isKleosTradingEnabled()) return fail(`RacerBot is not trading ${pad} coins right now. Nothing was spent.`, 503);
  if (info!.trade_block_reason) return fail(`${info!.trade_block_reason} Nothing was spent.`);
  const slippage = Number(req.slippagePct);
  const slippagePct = Number.isFinite(slippage) && slippage > 0 && slippage <= 50 ? slippage : user.slippage_pct ? Number(user.slippage_pct) : 2;
  const isBuy = String(req.side).toUpperCase() === 'BUY';

  if (isBuy) {
    const amountHype = Number(req.amountHype);
    if (!Number.isFinite(amountHype) || amountHype <= 0) {
      return fail(`${pad} coins on Elysium are bought with HYPE. Enter an amount in HYPE.`);
    }
    if (amountHype > MAX_WEB_BUY_HYPE) return fail(`A single web buy is limited to ${MAX_WEB_BUY_HYPE} HYPE.`);
    const evmUser = await ensureUserEvmWallet(user);
    if (!evmUser.evm_address) return fail('Your EVM wallet is not ready yet. Open RacerBot on Telegram and send /start.');
    const result = await publishSwap({
      user_id: user.id,
      chain: 'elysium',
      token_in: 'HYPE',
      token_out: tokenAddress,
      amount_in: String(amountHype),
      min_amount_out: '1',
      venue: info!.venue as any,
      slippage_pct: slippagePct,
    }, undefined, { suppressAlphaSignal: true });
    if (!result || result.success === false) return fail(result?.reason || `The ${pad} buy did not go through. Nothing was spent.`);
    return {
      status: 200,
      body: {
        success: true,
        chain: 'elysium',
        side: 'BUY',
        txHash: result.txHash,
        explorerUrl: result.txHash ? `${ELYSIUM_MAINNET_EXPLORER_URL}/tx/${result.txHash}` : undefined,
        tokenSymbol: result.tokenSymbol || info!.symbol,
        tokenQty: result.tokenQty,
        hypeSpent: amountHype,
        message: `Bought ${result.tokenSymbol || info!.symbol || 'the coin'} on ${pad} (Elysium).`,
      },
    };
  }

  const pct = req.sellPercent === undefined || req.sellPercent === null || req.sellPercent === '' ? 100 : Number(req.sellPercent);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return fail('Choose a sell amount between 1% and 100%.');
  const positions = await getOpenPositions(user.id);
  const position = positions.find(p => p.chain === 'elysium' && p.token_address.toLowerCase() === tokenAddress.toLowerCase());
  if (!position) return fail(`You have no ${info!.symbol || pad} position on Elysium in RacerBot to sell.`);
  const sold = await sellAtTarget(user.id, position.id, pct, undefined, { suppressAlphaSignal: true, slippagePct });
  if (!sold.success) return fail(sold.reason || `The ${pad} sell did not go through. You still hold the coins.`);
  return {
    status: 200,
    body: { success: true, chain: 'elysium', side: 'SELL', sellPercent: pct, message: `Sold ${pct}% of your ${info!.symbol || pad} on ${pad} (Elysium).` },
  };
}
