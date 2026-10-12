import 'dotenv/config';
import {
  decrypt,
  restoreSuiKeypair,
  getSuiBalance,
  getSuiTokenBalance,
  getSuiTokenMetadata,
  getSuiPumpCurveState,
  getSuiUsdPrice,
  getSuiRouterQuote,
  buildSuiRouterSwapTransaction,
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
  getActiveWallet,
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
 * Execute Sui Buy/Sell Swap on Sui Mainnet.
 * Supports SuiPump launchpad bonding curves as well as all DEXes (Bluefin, Cetus, Turbos, Aftermath, DeepBook, FlowX) via Aftermath Smart-Order Router.
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

  const activeSuiWallet = await getActiveWallet(user.id, 'sui').catch(() => null);
  const suiAddress = activeSuiWallet?.address || user.sui_address;
  const suiKeyEnc = activeSuiWallet?.encrypted_private_key || user.sui_private_key_enc;

  if (!suiAddress || !suiKeyEnc) {
    throw new Error('Sui wallet not configured. Please initialize your wallet via /start.');
  }

  // Decrypt and restore user's Ed25519 keypair
  const keypair = restoreSuiKeypair(suiKeyEnc, MASTER_KEY);
  const userAddress = suiAddress;

  const isBuy = token_in === 'sui' || token_in === '0x2::sui::SUI' || token_in === 'SUI' || token_in === '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

  if (isBuy) {
    onProgress?.('fetching_quote');
    const tokenTarget = token_out;
    const amountInMist = BigInt(amount_in);
    if (amountInMist <= 0n) {
      throw new Error('Buy amount must be greater than 0');
    }

    // Check on-chain SUI balance
    onProgress?.('checking_balance');
    const userSuiBal = await getSuiBalance(userAddress);
    
    // Minimal reserve in SUI remaining after swap to cover transaction gas
    // Keep at least 0.01 SUI (10,000,000 MIST = ~$0.02), allowing users to spend almost their entire balance
    const suiUsd = await getSuiUsdPrice().catch(() => 2.0);
    const effectiveSuiUsd = suiUsd > 0 ? suiUsd : 2.0;
    const minReserveSui = 0.01;
    const minReserveMist = BigInt(Math.ceil(minReserveSui * 1e9));
    const totalRequiredMist = amountInMist + minReserveMist;

    if (userSuiBal.mist < totalRequiredMist) {
      const availSui = (Number(userSuiBal.mist) / 1e9).toFixed(4);
      const availUsd = (Number(userSuiBal.mist) / 1e9 * effectiveSuiUsd).toFixed(2);
      const remainingMist = userSuiBal.mist > amountInMist ? userSuiBal.mist - amountInMist : 0n;
      const remainingSui = (Number(remainingMist) / 1e9).toFixed(4);
      const remainingUsd = (Number(remainingMist) / 1e9 * effectiveSuiUsd).toFixed(2);
      const requiredReserveSuiStr = minReserveSui.toFixed(4);

      throw new Error(
        `Insufficient balance after swap. Your wallet must keep a minimal reserve of ${requiredReserveSuiStr} SUI (~$${(minReserveSui * effectiveSuiUsd).toFixed(2)}) to cover transaction gas. You have $${availUsd} (${availSui} SUI), and would only have $${remainingUsd} (${remainingSui} SUI) left after this swap. Please reduce your buy amount or deposit more SUI.`
      );
    }

    const devFeeMist = (amountInMist * SUI_FEE_BPS) / SUI_BPS_DENOMINATOR;
    const swapMist = amountInMist - devFeeMist;

    // Check if token is on SuiPump bonding curve
    const curve = await getSuiPumpCurveState(tokenTarget);

    let txResult: any;
    let expectedTokensOut = 0n;
    let priceSui = 0;
    let tokenName = 'Sui Token';
    let tokenSymbol = 'TOKEN';
    let decimals = 6;
    let venue = 'sui_dex';

    if (curve && !curve.graduated) {
      venue = 'suipump';
      tokenName = curve.name;
      tokenSymbol = curve.symbol;
      decimals = curve.decimals;
      priceSui = curve.lastPriceSui;

      // AMM curve math: tokensOut = (reserveTokensRaw * swapMist) / (reserveSuiMist + swapMist)
      if (curve.reserveSuiMist > 0n && curve.reserveTokensRaw > 0n) {
        expectedTokensOut = (curve.reserveTokensRaw * swapMist) / (curve.reserveSuiMist + swapMist);
      }
      const tokensHuman = Number(expectedTokensOut) / Math.pow(10, decimals);
      const suiSpentHuman = Number(swapMist) / 1e9;
      priceSui = tokensHuman > 0 ? (suiSpentHuman / tokensHuman) : curve.lastPriceSui;

      const slippageBps = BigInt(Math.floor(slippage_pct * 100));
      const minTokensOut = expectedTokensOut > 0n
        ? (expectedTokensOut * (10000n - slippageBps)) / 10000n
        : 1n;

      onProgress?.('building_ptb');
      const { tx } = buildSuiPumpBuyTransaction({
        userAddress,
        curveId: curve.curveId,
        tokenType: curve.tokenType,
        packageId: curve.packageId,
        suiAmountMist: amountInMist,
        minTokensOut,
        slippagePct: slippage_pct,
        treasuryAddress: DEFAULT_SUI_TREASURY_ADDRESS,
      });

      onProgress?.('signing_and_broadcasting');
      txResult = await executeSuiTransaction(tx, keypair);
    } else {
      // Multi-DEX trade routing via Aftermath Smart-Order Router
      // Pass full buy amount and let Aftermath router collect 1.5% platform fee via externalFee natively in PTB
      const [meta, routerQuote] = await Promise.all([
        getSuiTokenMetadata(tokenTarget),
        getSuiRouterQuote({
          coinInType: '0x2::sui::SUI',
          coinOutType: tokenTarget,
          amountIn: amountInMist,
          treasuryAddress: DEFAULT_SUI_TREASURY_ADDRESS,
          includeFee: true,
        }),
      ]);

      if (!routerQuote) {
        throw new Error(`No swap route found for ${tokenTarget} on Sui DEXes. Please check liquidity.`);
      }

      tokenName = meta.name;
      tokenSymbol = meta.symbol;
      decimals = meta.decimals;
      expectedTokensOut = routerQuote.expectedAmountOut;
      venue = routerQuote.venue;

      const tokensHuman = Number(expectedTokensOut) / Math.pow(10, decimals);
      const suiSpentHuman = Number(amountInMist) / 1e9;
      priceSui = tokensHuman > 0 ? (suiSpentHuman / tokensHuman) : 0;

      onProgress?.('building_ptb');
      const tx = await buildSuiRouterSwapTransaction({
        walletAddress: userAddress,
        completeRoute: routerQuote.completeRoute,
        slippagePct: slippage_pct,
      });

      onProgress?.('signing_and_broadcasting');
      txResult = await executeSuiTransaction(tx, keypair);
    }

    if (txResult.status !== 'success') {
      throw new Error(`Sui transaction execution failed: ${txResult.errorMessage || 'Unknown Move error'}`);
    }

    onProgress?.('recording_position');

    // Create or update Position
    const openPositions = await getOpenPositions(user.id);
    let position = openPositions.find((p) => p.token_address === tokenTarget && p.chain === 'sui');

    const tokenQtyFormatted = (Number(expectedTokensOut) / Math.pow(10, decimals)).toFixed(4);
    const suiSpent = Number(amountInMist) / 1e9;
    const devFeeSui = Number(devFeeMist) / 1e9;

    if (!position) {
      position = await createPosition({
        user_id: user.id,
        chain: 'sui',
        token_address: tokenTarget,
        quantity_held: '0',
        avg_entry_price: '0',
      });
    }

    // Record Fill (update_position_fill trigger in DB will update quantity_held and avg_entry_price)
    const fillRes = await createFill({
      user_id: user.id,
      position_id: position.id,
      chain: 'sui',
      side: 'buy',
      token_address: tokenTarget,
      amount: expectedTokensOut.toString(),
      price: priceSui.toString(),
      fee_paid: devFeeSui.toString(),
      input_amount: suiSpent.toString(), // actual SUI spent on-chain (source of truth)
      venue: venue as any,
      tx_hash: txResult.digest,
    });

    // Record Dev Fee
    if (fillRes?.fillId) {
      await recordFee(fillRes.fillId, devFeeSui.toString()).catch(() => {});
    }

    return {
      txHash: txResult.digest,
      success: true,
      positionId: position.id,
      tokenName,
      tokenSymbol,
      tokenQty: tokenQtyFormatted,
      priceSui,
      suiSpent,
    };
  } else {
    // SELL PATH
    onProgress?.('fetching_quote');
    const tokenTarget = token_in;
    const tokenAmountRaw = BigInt(amount_in);
    if (tokenAmountRaw <= 0n) {
      throw new Error('Sell amount must be greater than 0');
    }

    // Fetch user's token balance & coin objects
    onProgress?.('checking_token_balance');
    const [meta, tokenBal, userSuiBal, curve] = await Promise.all([
      getSuiTokenMetadata(tokenTarget),
      getSuiTokenBalance(userAddress, tokenTarget),
      getSuiBalance(userAddress),
      getSuiPumpCurveState(tokenTarget),
    ]);

    if (tokenBal.raw < tokenAmountRaw) {
      const avail = (Number(tokenBal.raw) / Math.pow(10, meta.decimals)).toFixed(4);
      const req = (Number(tokenAmountRaw) / Math.pow(10, meta.decimals)).toFixed(4);
      throw new Error(`Insufficient token balance. You have ${avail} ${meta.symbol} available, but tried to sell ${req}.`);
    }

    // Check SUI gas reserve
    const minSellGas = 20_000_000n; // 0.02 SUI gas reserve
    if (userSuiBal.mist < minSellGas) {
      const avail = (Number(userSuiBal.mist) / 1e9).toFixed(4);
      throw new Error(`Insufficient SUI for transaction gas. You have ${avail} SUI. Need at least 0.0200 SUI for gas.`);
    }

    let txResult: any;
    let netSuiOut = 0n;
    let devFeeMist = 0n;
    let priceSui = 0;
    let venue = 'sui_dex';

    if (curve && !curve.graduated) {
      venue = 'suipump';
      priceSui = curve.lastPriceSui;

      // Compute expected SUI proceeds from curve math:
      let expectedSuiProceeds = 0n;
      if (curve.reserveSuiMist > 0n && curve.reserveTokensRaw > 0n) {
        expectedSuiProceeds = (curve.reserveSuiMist * tokenAmountRaw) / (curve.reserveTokensRaw + tokenAmountRaw);
      }

      const suiUsdPrice = await getSuiUsdPrice().catch(() => 2.0);
      const proceedsUsd = (Number(expectedSuiProceeds) / 1e9) * suiUsdPrice;
      const feeBps = proceedsUsd > 200 ? 200n : 150n;

      devFeeMist = (expectedSuiProceeds * feeBps) / SUI_BPS_DENOMINATOR;
      netSuiOut = expectedSuiProceeds - devFeeMist;

      const slippageBps = BigInt(Math.floor(slippage_pct * 100));
      const minSuiOut = netSuiOut > 0n
        ? (netSuiOut * (10000n - slippageBps)) / 10000n
        : 1n;

      onProgress?.('building_ptb');
      const { tx } = buildSuiPumpSellTransaction({
        userAddress,
        curveId: curve.curveId,
        tokenType: curve.tokenType,
        packageId: curve.packageId,
        tokenAmountRaw,
        tokenCoinObjectIds: tokenBal.coinObjectIds,
        feeMist: devFeeMist,
        minSuiOut,
        slippagePct: slippage_pct,
        treasuryAddress: DEFAULT_SUI_TREASURY_ADDRESS,
      });

      onProgress?.('signing_and_broadcasting');
      txResult = await executeSuiTransaction(tx, keypair);
    } else {
      // Multi-DEX sell route via Aftermath Smart-Order Router
      // Dynamic fee: 2% for sells above $200, 1.5% for sells <= $200
      const suiUsdPrice = await getSuiUsdPrice().catch(() => 2.0);
      const rawQuote = await getSuiRouterQuote({
        coinInType: tokenTarget,
        coinOutType: '0x2::sui::SUI',
        amountIn: tokenAmountRaw,
        includeFee: false,
      });

      if (!rawQuote) {
        throw new Error(`No sell route found for ${tokenTarget} on Sui DEXes. Please check pool liquidity.`);
      }

      const rawSuiProceeds = Number(rawQuote.expectedAmountOut) / 1e9;
      const proceedsUsd = rawSuiProceeds * suiUsdPrice;
      const isOver200 = proceedsUsd > 200;
      const feePercentage = isOver200 ? 0.02 : 0.015;
      const feeBps = isOver200 ? 200n : 150n;

      const routerQuote = await getSuiRouterQuote({
        coinInType: tokenTarget,
        coinOutType: '0x2::sui::SUI',
        amountIn: tokenAmountRaw,
        treasuryAddress: DEFAULT_SUI_TREASURY_ADDRESS,
        includeFee: true,
        feePercentage,
      }) || rawQuote;

      // Expected SUI proceeds after platform fee has already been routed to treasury
      netSuiOut = routerQuote.expectedAmountOut;
      devFeeMist = (netSuiOut * feeBps) / (SUI_BPS_DENOMINATOR - feeBps);
      venue = routerQuote.venue;

      const tokensHuman = Number(tokenAmountRaw) / Math.pow(10, meta.decimals);
      const suiHuman = Number(netSuiOut) / 1e9;
      priceSui = tokensHuman > 0 ? suiHuman / tokensHuman : 0;

      onProgress?.('building_ptb');
      const tx = await buildSuiRouterSwapTransaction({
        walletAddress: userAddress,
        completeRoute: routerQuote.completeRoute,
        slippagePct: slippage_pct,
      });

      onProgress?.('signing_and_broadcasting');
      txResult = await executeSuiTransaction(tx, keypair);
    }

    if (txResult.status !== 'success') {
      throw new Error(`Sui sell transaction failed: ${txResult.errorMessage || 'Unknown Move error'}`);
    }

    onProgress?.('updating_position');

    // Update or close position
    const openPositions = await getOpenPositions(user.id);
    const position = openPositions.find((p) => p.token_address === tokenTarget && p.chain === 'sui');

    const tokenQtyFormatted = (Number(tokenAmountRaw) / Math.pow(10, meta.decimals)).toFixed(4);
    const suiReceived = Number(netSuiOut) / 1e9;

    const devFeeSui = Number(devFeeMist) / 1e9;
    let fillId = '';
    if (position) {
      // Record Fill (update_position_fill trigger in DB will update quantity_held and close if 0)
      const fillRes = await createFill({
        user_id: user.id,
        position_id: position.id,
        chain: 'sui',
        side: 'sell',
        token_address: tokenTarget,
        amount: tokenAmountRaw.toString(),
        price: priceSui.toString(),
        fee_paid: devFeeSui.toString(),
        input_amount: suiReceived.toString(), // actual SUI received on-chain (source of truth)
        venue: venue as any,
        tx_hash: txResult.digest,
      });
      fillId = fillRes.fillId;
    }

    // Record Dev Fee
    if (fillId) {
      await recordFee(fillId, devFeeSui.toString()).catch(() => {});
    }

    return {
      txHash: txResult.digest,
      success: true,
      positionId: position?.id,
      tokenName: meta.name,
      tokenSymbol: meta.symbol,
      tokenQty: tokenQtyFormatted,
      priceSui,
      suiSpent: suiReceived,
    };
  }
}
