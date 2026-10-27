import 'dotenv/config';
import {
  SOL_MINT,
  SOLANA_FEE_BPS,
  SOLANA_BPS_DENOMINATOR,
  SOLANA_MIN_RESERVE_LAMPORTS,
  DEFAULT_SOLANA_DEV_FEE_WALLET,
  restoreSolanaKeypair,
  getSolanaBalance,
  getSolanaTokenBalance,
  getSolanaTokenBalanceOnChain,
  getSolanaTokenInfo,
  getSolUsdPrice,
  buildSolanaSwap,
  solanaSellFeeBps,
  sendAndConfirmSolanaTransaction,
  getSolanaTxDeltas,
  invalidateSolanaBalanceCache,
  lamportsToSol,
  type SwapEvent,
} from '@racerbot/shared';
import {
  getUserById,
  getActiveWallet,
  createFill,
  getOpenPositions,
  createPosition,
  recordFee,
  updatePosition,
} from '@racerbot/db';

const MASTER_KEY = process.env.KEY_ENCRYPTION_MASTER_KEY!;

export interface SolanaSwapExecutionResult {
  txHash: string;
  success: boolean;
  positionId?: string;
  reason?: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenQty?: string;
  /** Price per token in SOL. */
  priceSol?: number;
  /** Buy: SOL spent (fee included). Sell: SOL received after fee. */
  solAmount?: number;
}

function isSolInput(token: string): boolean {
  const t = (token || '').trim();
  return t === SOL_MINT || t.toLowerCase() === 'sol' || t.toLowerCase() === 'solana';
}

/**
 * Executes a Solana buy or sell for a user.
 * Routing goes through Jupiter, which covers pump.fun bonding curves
 * (pre-bonded) and every AMM a bonded token migrates to.
 * The platform fee (same rates as NEAR) is sent to the dev wallet in the same
 * transaction, so it is only paid when the swap succeeds.
 */
export async function executeSolanaSwap(
  event: SwapEvent,
  onProgress?: (stage: string) => void,
): Promise<SolanaSwapExecutionResult> {
  const { user_id, token_in, token_out, amount_in, slippage_pct = 5 } = event;
  onProgress?.('routing_solana');

  const user = await getUserById(user_id);
  if (!user) throw new Error(`User not found: ${user_id}`);

  const active = await getActiveWallet(user.id, 'solana').catch(() => null);
  const owner = active?.address || user.solana_address;
  const keyEnc = active?.encrypted_private_key || user.solana_private_key_enc;
  if (!owner || !keyEnc) {
    throw new Error('Solana wallet not set up yet. Please send /start to create it.');
  }
  const keypair = restoreSolanaKeypair(keyEnc, MASTER_KEY);
  if (keypair.publicKey.toBase58() !== owner) {
    throw new Error('Solana wallet key does not match the stored address. Please contact support.');
  }

  const slippageBps = Math.round(Math.max(0.5, Math.min(50, slippage_pct)) * 100);
  const isBuy = isSolInput(token_in);

  if (isBuy) {
    const mint = token_out;
    const grossLamports = BigInt(amount_in);
    if (grossLamports <= 0n) throw new Error('Buy amount must be greater than 0');

    onProgress?.('checking_balance');
    const [bal, info] = await Promise.all([getSolanaBalance(owner, true), getSolanaTokenInfo(mint)]);
    if (bal.lamports < grossLamports + SOLANA_MIN_RESERVE_LAMPORTS) {
      const have = lamportsToSol(bal.lamports).toFixed(4);
      const reserve = lamportsToSol(SOLANA_MIN_RESERVE_LAMPORTS).toFixed(3);
      throw new Error(
        `Insufficient SOL. You have ${have} SOL. Keep at least ${reserve} SOL for network fees and token account rent, then try a smaller amount.`,
      );
    }

    const feeLamports = (grossLamports * SOLANA_FEE_BPS) / SOLANA_BPS_DENOMINATOR;
    const swapLamports = grossLamports - feeLamports;

    onProgress?.('fetching_quote');
    const build = await buildSolanaSwap({
      owner,
      inputMint: SOL_MINT,
      outputMint: mint,
      amount: swapLamports,
      slippageBps,
      feeLamports,
      feeRecipient: DEFAULT_SOLANA_DEV_FEE_WALLET,
    });

    build.tx.sign([keypair]);
    const sent = await sendAndConfirmSolanaTransaction(build.tx, build.lastValidBlockHeight, onProgress);
    invalidateSolanaBalanceCache(owner);
    if (!sent.confirmed) {
      return { txHash: sent.signature, success: false, reason: sent.error || 'Solana buy failed' };
    }

    onProgress?.('recording_position');
    const deltas = await getSolanaTxDeltas(sent.signature, owner, mint);
    const decimals = info?.decimals ?? 6;
    const tokensRaw = deltas && deltas.tokenDelta > 0n ? deltas.tokenDelta : build.outAmount;
    const tokensHuman = Number(tokensRaw) / Math.pow(10, decimals);
    const solSpent = lamportsToSol(grossLamports);
    const swapSol = lamportsToSol(swapLamports);
    const priceSol = tokensHuman > 0 ? swapSol / tokensHuman : info?.priceSol ?? 0;
    const feeSol = lamportsToSol(feeLamports);

    const openPositions = await getOpenPositions(user.id);
    let position = openPositions.find((p) => p.token_address === mint && p.chain === 'solana');
    if (!position) {
      position = await createPosition({
        user_id: user.id,
        chain: 'solana',
        token_address: mint,
        quantity_held: '0',
        avg_entry_price: '0',
      });
    }

    const venue = info?.bondingPhase === 'prebonded' && info?.launchpad === 'pump.fun' ? 'pumpfun' : info?.launchpad === 'pump.fun' ? 'pumpswap' : 'jupiter';
    const fill = await createFill({
      user_id: user.id,
      position_id: position.id,
      chain: 'solana',
      side: 'buy',
      token_address: mint,
      amount: tokensRaw.toString(),
      price: priceSol.toString(),
      fee_paid: feeSol.toString(),
      input_amount: solSpent.toString(),
      venue: venue as any,
      tx_hash: sent.signature,
    });
    if (fill?.fillId && fill.inserted) await recordFee(fill.fillId, feeSol.toString()).catch(() => {});

    return {
      txHash: sent.signature,
      success: true,
      positionId: position.id,
      tokenName: info?.name,
      tokenSymbol: info?.symbol,
      tokenQty: tokensHuman.toFixed(4),
      priceSol,
      solAmount: solSpent,
    };
  }

  // ── SELL ────────────────────────────────────────────────────────────────
  const mint = token_in;
  if (!isSolInput(token_out)) throw new Error('Solana sells must output SOL');
  let sellRaw = BigInt(amount_in);
  if (sellRaw <= 0n) throw new Error('Sell amount must be greater than 0');

  onProgress?.('checking_token_balance');
  // Exact balance straight from the token accounts (one free RPC call). The
  // Jupiter holdings index is only a fallback: it is rate-limited and can lag.
  const [onChainRaw, solBal, info, solUsd] = await Promise.all([
    getSolanaTokenBalanceOnChain(owner, mint),
    getSolanaBalance(owner, true),
    getSolanaTokenInfo(mint),
    getSolUsdPrice(),
  ]);
  const balRaw = onChainRaw !== null
    ? onChainRaw
    : (await getSolanaTokenBalance(owner, mint, true).catch(() => null))?.raw ?? null;
  const decimals = info?.decimals ?? 6;
  if (balRaw !== null && balRaw <= 0n) {
    // Nothing left (sold elsewhere or sent out): close the position so TP/SL stops retrying.
    const open = await getOpenPositions(user.id).catch(() => []);
    const pos = open.find((p) => p.token_address === mint && p.chain === 'solana');
    if (pos) await updatePosition({ position_id: pos.id, status: 'closed', closed_at: new Date(), quantity_held: '0' }).catch(() => {});
    throw new Error(`No ${info?.symbol || 'tokens'} left in your Solana wallet to sell.`);
  }
  // The bot's record can be slightly above the wallet (transfers, token taxes):
  // sell what is really there instead of failing (critical for stop-losses).
  if (balRaw !== null && balRaw < sellRaw) sellRaw = balRaw;
  if (solBal.lamports < 1_000_000n) {
    throw new Error(`Insufficient SOL for network fees. You have ${lamportsToSol(solBal.lamports).toFixed(4)} SOL, need at least 0.001 SOL.`);
  }

  onProgress?.('fetching_quote');
  let feeLamports = 0n;
  const build = await buildSolanaSwap({
    owner,
    inputMint: mint,
    outputMint: SOL_MINT,
    amount: sellRaw,
    slippageBps,
    feeFromQuote: (outLamports) => {
      feeLamports = (outLamports * solanaSellFeeBps(outLamports, solUsd)) / SOLANA_BPS_DENOMINATOR;
      return feeLamports;
    },
    feeRecipient: DEFAULT_SOLANA_DEV_FEE_WALLET,
  });

  build.tx.sign([keypair]);
  const sent = await sendAndConfirmSolanaTransaction(build.tx, build.lastValidBlockHeight, onProgress);
  invalidateSolanaBalanceCache(owner);
  if (!sent.confirmed) {
    return { txHash: sent.signature, success: false, reason: sent.error || 'Solana sell failed' };
  }

  onProgress?.('updating_position');
  const deltas = await getSolanaTxDeltas(sent.signature, owner, mint);
  const soldRaw = deltas && deltas.tokenDelta < 0n ? -deltas.tokenDelta : sellRaw;
  const soldHuman = Number(soldRaw) / Math.pow(10, decimals);
  // Net SOL received after the platform fee (network fee added back so it is not counted as trade loss).
  const netLamports = deltas ? deltas.solDelta + deltas.feeLamports : build.outAmount - feeLamports;
  const solReceived = lamportsToSol(netLamports > 0n ? netLamports : 0n);
  const grossSol = lamportsToSol(build.outAmount);
  const priceSol = soldHuman > 0 ? grossSol / soldHuman : info?.priceSol ?? 0;
  const feeSol = lamportsToSol(feeLamports);

  const openPositions = await getOpenPositions(user.id);
  const position = openPositions.find((p) => p.token_address === mint && p.chain === 'solana');
  if (position) {
    const fill = await createFill({
      user_id: user.id,
      position_id: position.id,
      chain: 'solana',
      side: 'sell',
      token_address: mint,
      amount: soldRaw.toString(),
      price: priceSol.toString(),
      fee_paid: feeSol.toString(),
      input_amount: solReceived.toString(),
      venue: (info?.launchpad === 'pump.fun' ? (info.bondingPhase === 'prebonded' ? 'pumpfun' : 'pumpswap') : 'jupiter') as any,
      tx_hash: sent.signature,
    });
    if (fill?.fillId && fill.inserted) await recordFee(fill.fillId, feeSol.toString()).catch(() => {});
  }

  return {
    txHash: sent.signature,
    success: true,
    positionId: position?.id,
    tokenName: info?.name,
    tokenSymbol: info?.symbol,
    tokenQty: soldHuman.toFixed(4),
    priceSol,
    solAmount: solReceived,
  };
}
