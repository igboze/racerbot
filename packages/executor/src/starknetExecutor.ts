import 'dotenv/config';
import {
  decrypt,
  getStarknetProvider,
  getStarknetAccount,
  getStarknetBalance,
  getStarknetTokenBalance,
  getStarknetTokenMetadata,
  formatTokenBalance,
  STRK_TOKEN_ADDRESS,
  ETH_TOKEN_ADDRESS,
  OZ_ACCOUNT_CLASS_HASH,
  computeStarknetAccountAddress,
  getStarknetTreasuryAddress,
  invalidateStarknetBalanceCache,
  DEFAULT_STARKNET_TREASURY_ADDRESS,
  STARKNET_FEE_BPS,
  STARKNET_BPS_DENOMINATOR,
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
import { getQuotes, quoteToCalls } from '@avnu/avnu-sdk';
import { CallData, uint256, ec } from 'starknet';

const MASTER_KEY = process.env.KEY_ENCRYPTION_MASTER_KEY!;
const DEPLOYED_ACCOUNTS_CACHE = new Set<string>();

export interface StarknetSwapExecutionResult {
  txHash: string;
  success: boolean;
  positionId?: string;
  reason?: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenQty?: string;
  price?: number;
  spent?: number;
  gasTokenUsed?: 'STRK' | 'ETH';
}

function isNativeStarknetToken(addr: string): boolean {
  const lower = (addr || '').toLowerCase();
  return (
    lower === 'strk' ||
    lower === 'eth' ||
    lower === STRK_TOKEN_ADDRESS.toLowerCase() ||
    lower === ETH_TOKEN_ADDRESS.toLowerCase()
  );
}

function resolveCanonicalToken(addr: string): string {
  const lower = (addr || '').toLowerCase();
  if (lower === 'strk') return STRK_TOKEN_ADDRESS;
  if (lower === 'eth') return ETH_TOKEN_ADDRESS;
  return addr;
}

/**
 * Execute Starknet Buy/Sell Swap on Starknet Mainnet.
 * Automatically handles gas in either STRK or ETH depending on user balance.
 * Integrates AVNU aggregator & Ekubo liquidity routing with atomic platform fee.
 */
export async function executeStarknetSwap(
  event: SwapEvent,
  onProgress?: (stage: string) => void
): Promise<StarknetSwapExecutionResult> {
  const { user_id, token_in, token_out, amount_in, slippage_pct = 2 } = event;

  onProgress?.('routing_starknet');

  const user = await getUserById(user_id);
  if (!user) {
    throw new Error(`User not found: ${user_id}`);
  }

  const activeWallet = await getActiveWallet(user.id, 'starknet').catch(() => null);
  const userAddress = activeWallet?.address || user.starknet_address;
  const userKeyEnc = activeWallet?.encrypted_private_key || user.starknet_private_key_enc;

  if (!userAddress || !userKeyEnc) {
    throw new Error('Starknet wallet not initialized. Please tap /wallets or /start to view your Starknet address.');
  }

  const privateKeySecret = decrypt(userKeyEnc, MASTER_KEY);
  const provider = getStarknetProvider();
  const account = getStarknetAccount(privateKeySecret, userAddress, provider);

  const tokenInCanonical = resolveCanonicalToken(token_in);
  const tokenOutCanonical = resolveCanonicalToken(token_out);
  const isBuy = isNativeStarknetToken(token_in);

  // 1. Check user gas balances (STRK vs ETH)
  onProgress?.('checking_gas');
  const balances = await getStarknetBalance(userAddress);
  const hasStrkGas = balances.strk > 500_000_000_000_000n; // > 0.0005 STRK
  const hasEthGas = balances.eth > 500_000_000_000_000n;   // > 0.0005 ETH

  if (!hasStrkGas && !hasEthGas) {
    throw new Error(
      'Insufficient gas on Starknet. Please deposit a small amount of STRK or ETH to cover network gas fees.'
    );
  }

  const gasTokenUsed: 'STRK' | 'ETH' = hasStrkGas ? 'STRK' : 'ETH';

  // 2. Amount In validation
  const amountInBigInt = BigInt(amount_in);
  if (amountInBigInt <= 0n) {
    throw new Error('Swap amount must be greater than 0.');
  }

  // 3. Platform Fee & AVNU Quote setup
  // For Buys: fee is deducted from the native input token (STRK/ETH) before the swap
  // For Sells: the full token amount is swapped, and fee is deducted from the native proceeds (STRK/ETH)
  let sellAmountForQuote: bigint;
  let buyFeeAmount = 0n;

  if (isBuy) {
    buyFeeAmount = (amountInBigInt * STARKNET_FEE_BPS) / STARKNET_BPS_DENOMINATOR;
    sellAmountForQuote = amountInBigInt - buyFeeAmount;
    if (sellAmountForQuote <= 0n) {
      throw new Error('Amount too small after platform fee.');
    }
  } else {
    sellAmountForQuote = amountInBigInt;
  }

  onProgress?.('fetching_quote');

  // 4. Fetch quote from AVNU (Ekubo, JediSwap, Nostra, 10KSwap)
  const quotes = await getQuotes({
    sellTokenAddress: tokenInCanonical,
    buyTokenAddress: tokenOutCanonical,
    sellAmount: sellAmountForQuote,
    takerAddress: userAddress,
    size: 1,
  }).catch((err) => {
    console.warn('[STARKNET_EXECUTOR] AVNU getQuotes warning:', err?.message);
    return [];
  });

  if (!quotes || quotes.length === 0) {
    throw new Error('No liquid route found on Starknet for this token pair. The DEX pool (Ekubo/AVNU) currently has insufficient active liquidity or is out of tick range.');
  }

  const selectedQuote = quotes[0];
  const targetTokenMetadata = await getStarknetTokenMetadata(isBuy ? tokenOutCanonical : tokenInCanonical);

  onProgress?.('building_transaction');

  // 5. Construct multicall transactions:
  // - For Buys: [feeTransferCall, ...avnuCalls]
  // - For Sells: [...avnuCalls, feeTransferCall] (transfer dev fee in STRK/ETH after swap lands)
  let nativeFeeAmount: bigint;
  let feeTokenAddress: string;

  if (isBuy) {
    nativeFeeAmount = buyFeeAmount;
    feeTokenAddress = tokenInCanonical;
  } else {
    nativeFeeAmount = (BigInt(selectedQuote.buyAmount) * STARKNET_FEE_BPS) / STARKNET_BPS_DENOMINATOR;
    feeTokenAddress = tokenOutCanonical;
  }

  const feeTransferCall = {
    contractAddress: feeTokenAddress,
    entrypoint: 'transfer',
    calldata: CallData.compile({
      recipient: getStarknetTreasuryAddress(),
      amount: uint256.bnToUint256(nativeFeeAmount),
    }),
  };

  const { calls: avnuCalls } = await quoteToCalls({
    quoteId: selectedQuote.quoteId,
    slippage: (slippage_pct || 2) / 100,
    takerAddress: userAddress,
  });

  const parsedAvnuCalls = avnuCalls.map((c: any) => ({
    contractAddress: c.contractAddress,
    entrypoint: c.entrypoint,
    calldata: c.calldata,
  }));

  const callsToExecute = isBuy
    ? [feeTransferCall, ...parsedAvnuCalls]
    : [...parsedAvnuCalls, feeTransferCall];

  // 5b. Auto-deploy account if undeployed (Starknet Account Abstraction requirement)
  const normAddress = userAddress.toLowerCase();
  let isDeployed = DEPLOYED_ACCOUNTS_CACHE.has(normAddress);
  if (!isDeployed) {
    try {
      const classHash = await provider.getClassHashAt(userAddress);
      if (classHash) {
        isDeployed = true;
        DEPLOYED_ACCOUNTS_CACHE.add(normAddress);
      }
    } catch {
      isDeployed = false;
    }
  }

  if (!isDeployed) {
    onProgress?.('deploying_account');
    const publicKey = ec.starkCurve.getStarkKey(privateKeySecret);
    const expectedAddress = computeStarknetAccountAddress(publicKey);

    // Verify user address matches canonical OZ account address (modulo leading zeros)
    try {
      if (BigInt(expectedAddress) !== BigInt(userAddress)) {
        throw new Error(
          `Your Starknet wallet (${userAddress.slice(0, 10)}...) was created with a legacy format and cannot be deployed on-chain.\n` +
          `Please run /newstarknet in the bot to switch to a fresh canonical Starknet wallet.`
        );
      }
    } catch (e: any) {
      if (e.message.includes('legacy format')) throw e;
    }

    console.log(`[STARKNET_EXECUTOR] Account ${userAddress} is undeployed on-chain. Auto-deploying OpenZeppelin Account contract...`);
    const deployRes = await account.deployAccount({
      classHash: OZ_ACCOUNT_CLASS_HASH,
      constructorCalldata: CallData.compile({ publicKey }),
      addressSalt: publicKey,
    });
    console.log(`[STARKNET_EXECUTOR] Account deployment tx submitted: ${deployRes.transaction_hash}. Waiting for confirmation...`);
    await provider.waitForTransaction(deployRes.transaction_hash, { retryInterval: 1500 });
    DEPLOYED_ACCOUNTS_CACHE.add(normAddress);
    console.log(`[STARKNET_EXECUTOR] Account ${userAddress} successfully deployed on Starknet!`);
  }

  onProgress?.('executing_swap');

  // 6. Sign and submit transaction
  const txResponse = await account.execute(callsToExecute);
  const txHash = txResponse.transaction_hash;

  onProgress?.('confirming_tx');
  await provider.waitForTransaction(txHash, { retryInterval: 1500 }).catch((err) => {
    console.warn(`[STARKNET_EXECUTOR] waitForTransaction warning for ${txHash}:`, err?.message);
  });

  // Evict balance cache so next wallet/balance fetch immediately shows new balance
  invalidateStarknetBalanceCache(userAddress);

  const humanFee = Number(nativeFeeAmount) / 1e18;

  // 7. Update Positions and Fills
  const rawBuyQty = selectedQuote.buyAmount ? selectedQuote.buyAmount.toString() : '0';
  const humanBuyQty = selectedQuote.buyAmount
    ? formatTokenBalance(selectedQuote.buyAmount, targetTokenMetadata.decimals)
    : '0';

  const humanBuyQtyNum = Number(rawBuyQty) / Math.pow(10, targetTokenMetadata.decimals);
  const humanNetIn = Number(sellAmountForQuote) / 1e18;
  const buyPricePerToken = humanBuyQtyNum > 0 ? humanNetIn / humanBuyQtyNum : 0;

  const humanSellQtyNum = Number(amountInBigInt) / Math.pow(10, targetTokenMetadata.decimals);
  const humanGrossProceeds = Number(selectedQuote.buyAmount) / 1e18;
  const humanNetProceeds = (Number(selectedQuote.buyAmount) - Number(nativeFeeAmount)) / 1e18;
  const sellPricePerToken = humanSellQtyNum > 0 ? humanGrossProceeds / humanSellQtyNum : 0;

  let positionId: string | undefined;

  if (isBuy) {
    const existingPositions = await getOpenPositions(user.id).catch(() => []);
    const matchingPos = existingPositions.find(
      (p) => p.chain === 'starknet' && p.token_address.toLowerCase() === tokenOutCanonical.toLowerCase()
    );

    if (matchingPos) {
      const prevBig = BigInt((matchingPos.quantity_held || '0').split('.')[0]);
      const prevHuman = Number(prevBig) / Math.pow(10, targetTokenMetadata.decimals);
      const prevEntry = parseFloat(matchingPos.avg_entry_price || '0');
      const newQty = (prevBig + BigInt(rawBuyQty)).toString();
      const newHuman = prevHuman + humanBuyQtyNum;
      const weightedEntry = newHuman > 0 ? (prevHuman * prevEntry + humanNetIn) / newHuman : buyPricePerToken;
      await updatePosition({
        position_id: matchingPos.id,
        quantity_held: newQty,
        avg_entry_price: weightedEntry.toString(),
      }).catch((e) => console.warn('[STARKNET_EXECUTOR] updatePosition error:', e?.message));
      positionId = matchingPos.id;
    } else {
      const newPos = await createPosition({
        user_id: user.id,
        chain: 'starknet',
        token_address: tokenOutCanonical,
        quantity_held: rawBuyQty,
        avg_entry_price: buyPricePerToken.toString(),
      }).catch((e) => {
        console.warn('[STARKNET_EXECUTOR] createPosition error:', e?.message);
        return null;
      });
      positionId = newPos?.id;
    }
  } else {
    // SELL: locate the position, update remaining tokens or close
    const existingPositions = await getOpenPositions(user.id).catch(() => []);
    const matchingPos = existingPositions.find(
      (p) => p.chain === 'starknet' && p.token_address.toLowerCase() === tokenInCanonical.toLowerCase()
    );

    if (matchingPos) {
      positionId = matchingPos.id;
      const prevBig = BigInt((matchingPos.quantity_held || '0').split('.')[0]);
      const remainingQty = prevBig > amountInBigInt ? prevBig - amountInBigInt : 0n;

      if (remainingQty === 0n) {
        await updatePosition({
          position_id: matchingPos.id,
          quantity_held: '0',
          status: 'closed',
          closed_at: new Date(),
        }).catch((e) => console.warn('[STARKNET_EXECUTOR] close position error:', e?.message));
      } else {
        await updatePosition({
          position_id: matchingPos.id,
          quantity_held: remainingQty.toString(),
        }).catch((e) => console.warn('[STARKNET_EXECUTOR] update position error:', e?.message));
      }
    }
  }

  if (positionId) {
    const fillRes = await createFill({
      user_id: user.id,
      position_id: positionId,
      chain: 'starknet',
      side: isBuy ? 'buy' : 'sell',
      token_address: isBuy ? tokenOutCanonical : tokenInCanonical,
      amount: isBuy ? rawBuyQty : amountInBigInt.toString(),
      price: isBuy ? buyPricePerToken.toString() : sellPricePerToken.toString(),
      fee_paid: humanFee.toString(),
      input_amount: isBuy
        ? (Number(amountInBigInt) / 1e18).toString()
        : humanNetProceeds.toString(),
      venue: 'avnu',
      tx_hash: txHash,
    }).catch((e) => {
      console.warn('[STARKNET_EXECUTOR] createFill error:', e?.message);
      return null;
    });

    if (fillRes?.fillId) {
      await recordFee(fillRes.fillId, humanFee.toString()).catch((e) =>
        console.warn('[STARKNET_EXECUTOR] recordFee error:', e?.message)
      );
    }
  }

  return {
    txHash,
    success: true,
    positionId,
    tokenName: targetTokenMetadata.name,
    tokenSymbol: targetTokenMetadata.symbol,
    tokenQty: isBuy ? humanBuyQty : formatTokenBalance(amountInBigInt, targetTokenMetadata.decimals),
    spent: isBuy ? Number(amountInBigInt) / 1e18 : humanNetProceeds,
    gasTokenUsed,
  };
}
