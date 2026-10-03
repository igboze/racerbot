import 'dotenv/config';
import {
  decrypt,
  restoreSuiKeypair,
  getSuiBalance,
  getSuiTokenBalance,
  getSuiPumpCurveState,
  getSuiUsdPrice,
  buildSuiPumpBuyTransaction,
  buildSuiPumpSellTransaction,
  executeSuiTransaction,
  DEFAULT_SUI_TREASURY_ADDRESS,
  SUI_FEE_BPS,
  SUI_BPS_DENOMINATOR,
  type SwapEvent,
} from '@racerbot/shared';
import {
  getUserById,
  createFill,
  getOpenPositions,
  createPosition,
  updatePosition,
  recordFee,
} from '@racerbot/db';

const MASTER_KEY = process.env.KEY_ENCRYPTION_MASTER_KEY!;

export interface SuiSwapExecutionResult {
  txHash: string;
  success: boolean;
  positionId?: string;
  reason?: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenQty?: string;
  priceSui?: number;
  suiSpent?: number;
}

/**
 * Execute SuiPump Buy/Sell Swap on Sui Mainnet.
 * Fully on-chain, non-simulated, with 1.5% dev fee atomically routed to treasury.
 */
export async function executeSuiSwap(
  event: SwapEvent,
  onProgress?: (stage: string) => void
): Promise<SuiSwapExecutionResult> {
  const { user_id, token_in, token_out, amount_in, slippage_pct = 2 } = event;

  onProgress?.('routing_sui');

  const user = await getUserById(user_id);
  if (!user) {
    throw new Error(`User not found: ${user_id}`);
  }

  if (!user.sui_address || !user.sui_private_key_enc) {
    throw new Error('Sui wallet not configured. Please initialize your wallet via /start.');
  }

  // Decrypt and restore user's Ed25519 keypair
  const keypair = restoreSuiKeypair(user.sui_private_key_enc, MASTER_KEY);
  const userAddress = user.sui_address;

  const isBuy = token_in === 'sui' || token_in === '0x2::sui::SUI' || token_in === 'SUI';

  if (isBuy) {
    onProgress?.('fetching_curve');
    const tokenTarget = token_out;
    const curve = await getSuiPumpCurveState(tokenTarget);
    if (!curve) {
      throw new Error(`SuiPump token or curve not found: ${tokenTarget}`);
    }

    const amountInMist = BigInt(amount_in);
    if (amountInMist <= 0n) {
      throw new Error('Buy amount must be greater than 0');
    }

    // Check on-chain SUI balance
    onProgress?.('checking_balance');
    const userSuiBal = await getSuiBalance(userAddress);
    const gasReserveMist = 50_000_000n; // 0.05 SUI reserve for gas
    const totalRequiredMist = amountInMist + gasReserveMist;

    if (userSuiBal.mist < totalRequiredMist) {
      const avail = (Number(userSuiBal.mist) / 1e9).toFixed(4);
      const req = (Number(totalRequiredMist) / 1e9).toFixed(4);
      throw new Error(`Insufficient SUI balance. You have ${avail} SUI available. Need at least ${req} SUI (including gas reserve).`);
    }

    // Compute expected tokens out and min tokens out
    const devFeeMist = (amountInMist * SUI_FEE_BPS) / SUI_BPS_DENOMINATOR;
    const swapMist = amountInMist - devFeeMist;

    // AMM curve math: tokensOut = (reserveTokensRaw * swapMist) / (reserveSuiMist + swapMist)
    let expectedTokensOut = 0n;
    if (curve.reserveSuiMist > 0n && curve.reserveTokensRaw > 0n) {
      expectedTokensOut = (curve.reserveTokensRaw * swapMist) / (curve.reserveSuiMist + swapMist);
    }
    const slippageBps = BigInt(Math.floor(slippage_pct * 100));
    const minTokensOut = expectedTokensOut > 0n
      ? (expectedTokensOut * (10000n - slippageBps)) / 10000n
      : 1n;

    onProgress?.('building_ptb');
    const { tx } = buildSuiPumpBuyTransaction({
      userAddress,
      curveId: curve.curveId,
      tokenType: curve.tokenType,
      suiAmountMist: amountInMist,
      slippagePct: slippage_pct,
      treasuryAddress: DEFAULT_SUI_TREASURY_ADDRESS,
    });

    onProgress?.('signing_and_broadcasting');
    const txResult = await executeSuiTransaction(tx, keypair);

    if (txResult.status !== 'success') {
      throw new Error(`Sui transaction execution failed: ${txResult.errorMessage || 'Unknown Move error'}`);
    }

    onProgress?.('recording_position');

    // Create or update Position
    const openPositions = await getOpenPositions(user.id);
    let position = openPositions.find((p) => p.token_address === curve.tokenType && p.chain === 'sui');

    const tokenQtyFormatted = (Number(expectedTokensOut) / Math.pow(10, curve.decimals)).toFixed(4);
    const priceSui = curve.lastPriceSui;
    const suiSpent = Number(amountInMist) / 1e9;

    if (!position) {
      position = await createPosition({
        user_id: user.id,
        chain: 'sui',
        token_address: curve.tokenType,
        quantity_held: expectedTokensOut.toString(),
        avg_entry_price: priceSui.toString(),
      });
    } else {
      const currentQty = BigInt(position.quantity_held || '0');
      const newQty = currentQty + expectedTokensOut;
      await updatePosition({
        position_id: position.id,
        quantity_held: newQty.toString(),
      });
    }

    // Record Fill
    const fillRes = await createFill({
      user_id: user.id,
      position_id: position.id,
      chain: 'sui',
      side: 'buy',
      token_address: curve.tokenType,
      amount: expectedTokensOut.toString(),
      price: priceSui.toString(),
      fee_paid: devFeeMist.toString(),
      venue: 'suipump',
      tx_hash: txResult.digest,
    });

    // Record Dev Fee
    if (fillRes?.fillId) {
      await recordFee(fillRes.fillId, devFeeMist.toString()).catch(() => {});
    }

    return {
      txHash: txResult.digest,
      success: true,
      positionId: position.id,
      tokenName: curve.name,
      tokenSymbol: curve.symbol,
      tokenQty: tokenQtyFormatted,
      priceSui,
      suiSpent,
    };
  } else {
    // SELL PATH
    onProgress?.('fetching_curve');
    const tokenTarget = token_in;
    const curve = await getSuiPumpCurveState(tokenTarget);
    if (!curve) {
      throw new Error(`SuiPump token or curve not found: ${tokenTarget}`);
    }

    const tokenAmountRaw = BigInt(amount_in);
    if (tokenAmountRaw <= 0n) {
      throw new Error('Sell amount must be greater than 0');
    }

    // Fetch user's token balance & coin objects
    onProgress?.('checking_token_balance');
    const tokenBal = await getSuiTokenBalance(userAddress, curve.tokenType);

    if (tokenBal.raw < tokenAmountRaw) {
      const avail = (Number(tokenBal.raw) / Math.pow(10, curve.decimals)).toFixed(4);
      const req = (Number(tokenAmountRaw) / Math.pow(10, curve.decimals)).toFixed(4);
      throw new Error(`Insufficient token balance. You have ${avail} ${curve.symbol} available, but tried to sell ${req}.`);
    }

    // Check SUI gas reserve
    const userSuiBal = await getSuiBalance(userAddress);
    const minSellGas = 20_000_000n; // 0.02 SUI gas reserve
    if (userSuiBal.mist < minSellGas) {
      const avail = (Number(userSuiBal.mist) / 1e9).toFixed(4);
      throw new Error(`Insufficient SUI for transaction gas. You have ${avail} SUI. Need at least 0.0200 SUI for gas.`);
    }

    // Compute expected SUI proceeds from curve math:
    // suiProceeds = (reserveSuiMist * tokenAmountRaw) / (reserveTokensRaw + tokenAmountRaw)
    let expectedSuiProceeds = 0n;
    if (curve.reserveSuiMist > 0n && curve.reserveTokensRaw > 0n) {
      expectedSuiProceeds = (curve.reserveSuiMist * tokenAmountRaw) / (curve.reserveTokensRaw + tokenAmountRaw);
    }

    const devFeeMist = (expectedSuiProceeds * SUI_FEE_BPS) / SUI_BPS_DENOMINATOR;
    const netSuiOut = expectedSuiProceeds - devFeeMist;

    const slippageBps = BigInt(Math.floor(slippage_pct * 100));
    const minSuiOut = netSuiOut > 0n
      ? (netSuiOut * (10000n - slippageBps)) / 10000n
      : 1n;

    onProgress?.('building_ptb');
    const { tx } = buildSuiPumpSellTransaction({
      userAddress,
      curveId: curve.curveId,
      tokenType: curve.tokenType,
      tokenAmountRaw,
      tokenCoinObjectIds: tokenBal.coinObjectIds,
      feeMist: devFeeMist,
      minSuiOut,
      slippagePct: slippage_pct,
      treasuryAddress: DEFAULT_SUI_TREASURY_ADDRESS,
    });

    onProgress?.('signing_and_broadcasting');
    const txResult = await executeSuiTransaction(tx, keypair);

    if (txResult.status !== 'success') {
      throw new Error(`Sui sell transaction failed: ${txResult.errorMessage || 'Unknown Move error'}`);
    }

    onProgress?.('updating_position');

    // Update or close position
    const openPositions = await getOpenPositions(user.id);
    const position = openPositions.find((p) => p.token_address === curve.tokenType && p.chain === 'sui');

    const tokenQtyFormatted = (Number(tokenAmountRaw) / Math.pow(10, curve.decimals)).toFixed(4);
    const priceSui = curve.lastPriceSui;
    const suiReceived = Number(netSuiOut) / 1e9;

    let fillId = '';
    if (position) {
      const currentQty = BigInt(position.quantity_held || '0');
      const newQty = currentQty > tokenAmountRaw ? currentQty - tokenAmountRaw : 0n;
      if (newQty === 0n) {
        await updatePosition({
          position_id: position.id,
          quantity_held: '0',
          status: 'closed',
          closed_at: new Date(),
        });
      } else {
        await updatePosition({
          position_id: position.id,
          quantity_held: newQty.toString(),
        });
      }

      // Record Fill
      const fillRes = await createFill({
        user_id: user.id,
        position_id: position.id,
        chain: 'sui',
        side: 'sell',
        token_address: curve.tokenType,
        amount: tokenAmountRaw.toString(),
        price: priceSui.toString(),
        fee_paid: devFeeMist.toString(),
        venue: 'suipump',
        tx_hash: txResult.digest,
      });
      fillId = fillRes.fillId;
    }

    // Record Dev Fee
    if (fillId) {
      await recordFee(fillId, devFeeMist.toString()).catch(() => {});
    }

    return {
      txHash: txResult.digest,
      success: true,
      positionId: position?.id,
      tokenName: curve.name,
      tokenSymbol: curve.symbol,
      tokenQty: tokenQtyFormatted,
      priceSui,
      suiSpent: suiReceived,
    };
  }
}
