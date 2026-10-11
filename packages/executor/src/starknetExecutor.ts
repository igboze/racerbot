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

  // 3. Platform Fee deduction (1.5%)
  const platformFeeAmount = (amountInBigInt * STARKNET_FEE_BPS) / STARKNET_BPS_DENOMINATOR;
  const netAmountIn = amountInBigInt - platformFeeAmount;

  if (netAmountIn <= 0n) {
    throw new Error('Amount too small after platform fee.');
  }

  onProgress?.('fetching_quote');

  // 4. Fetch quote from AVNU (Ekubo, JediSwap, Nostra, 10KSwap)
  const quotes = await getQuotes({
    sellTokenAddress: tokenInCanonical,
    buyTokenAddress: tokenOutCanonical,
    sellAmount: netAmountIn,
    takerAddress: userAddress,
    size: 1,
  }).catch((err) => {
    console.warn('[STARKNET_EXECUTOR] AVNU getQuotes warning:', err?.message);
    return [];
  });

  if (!quotes || quotes.length === 0) {
    throw new Error('No liquid route found on Starknet for this token pair.');
  }

  const selectedQuote = quotes[0];
  const targetTokenMetadata = await getStarknetTokenMetadata(isBuy ? tokenOutCanonical : tokenInCanonical);

  onProgress?.('building_transaction');

  // 5. Construct multicall transactions:
  // - Transfer platform fee to treasury
  // - Execute swap via AVNU router
  const feeTransferCall = {
    contractAddress: tokenInCanonical,
    entrypoint: 'transfer',
    calldata: CallData.compile({
      recipient: getStarknetTreasuryAddress(),
      amount: uint256.bnToUint256(platformFeeAmount),
    }),
  };

  const { calls: avnuCalls } = await quoteToCalls({
    quoteId: selectedQuote.quoteId,
    slippage: (slippage_pct || 2) / 100,
    takerAddress: userAddress,
  });

  const callsToExecute = [
    feeTransferCall,
    ...avnuCalls.map((c: any) => ({
      contractAddress: c.contractAddress,
      entrypoint: c.entrypoint,
      calldata: c.calldata,
    })),
  ];

  // 5b. Auto-deploy account if undeployed (Starknet Account Abstraction requirement)
  let isDeployed = false;
  try {
    const classHash = await provider.getClassHashAt(userAddress);
    if (classHash) isDeployed = true;
  } catch {
    isDeployed = false;
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
    await provider.waitForTransaction(deployRes.transaction_hash);
    console.log(`[STARKNET_EXECUTOR] Account ${userAddress} successfully deployed on Starknet!`);
  }

  onProgress?.('executing_swap');

  // 6. Sign and submit transaction
  const txResponse = await account.execute(callsToExecute);
  const txHash = txResponse.transaction_hash;

  onProgress?.('confirming_tx');
  await provider.waitForTransaction(txHash).catch((err) => {
    console.warn(`[STARKNET_EXECUTOR] waitForTransaction warning for ${txHash}:`, err?.message);
  });

  // Evict balance cache so next wallet/balance fetch immediately shows new balance
  invalidateStarknetBalanceCache(userAddress);

  const humanFee = Number(platformFeeAmount) / 1e18;

  // 7. Update Positions and Fills
  const estimatedBuyQty = selectedQuote.buyAmount
    ? formatTokenBalance(selectedQuote.buyAmount, targetTokenMetadata.decimals)
    : '0';

  let positionId: string | undefined;

  if (isBuy) {
    const existingPositions = await getOpenPositions(user.id).catch(() => []);
    const matchingPos = existingPositions.find(
      (p) => p.chain === 'starknet' && p.token_address.toLowerCase() === tokenOutCanonical.toLowerCase()
    );

    if (matchingPos) {
      const newQty = (parseFloat(matchingPos.quantity_held) + parseFloat(estimatedBuyQty)).toString();
      await updatePosition({
        position_id: matchingPos.id,
        quantity_held: newQty,
      }).catch((e) => console.warn('[STARKNET_EXECUTOR] updatePosition error:', e?.message));
      positionId = matchingPos.id;
    } else {
      const newPos = await createPosition({
        user_id: user.id,
        chain: 'starknet',
        token_address: tokenOutCanonical,
        quantity_held: estimatedBuyQty,
        avg_entry_price: (Number(netAmountIn) / 1e18).toString(),
      }).catch((e) => {
        console.warn('[STARKNET_EXECUTOR] createPosition error:', e?.message);
        return null;
      });
      positionId = newPos?.id;
    }
  }

  if (positionId) {
    const fillRes = await createFill({
      user_id: user.id,
      position_id: positionId,
      chain: 'starknet',
      side: isBuy ? 'buy' : 'sell',
      token_address: isBuy ? tokenOutCanonical : tokenInCanonical,
      amount: estimatedBuyQty,
      price: (Number(netAmountIn) / 1e18).toString(),
      fee_paid: humanFee.toString(),
      input_amount: (Number(amountInBigInt) / 1e18).toString(),
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
    tokenQty: estimatedBuyQty,
    spent: Number(amountInBigInt) / 1e18,
    gasTokenUsed,
  };
}
