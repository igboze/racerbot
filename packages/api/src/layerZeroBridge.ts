/**
 * LayerZero V2 & Stargate V2 Cross-Chain Execution & 1-Click Buy Engine.
 *
 * Provides:
 *  - Cross-chain balance scanning across EVM networks (Arbitrum, Base, Ethereum, Optimism).
 *  - Stargate V2 bridging with live fee quoting, automatic ERC20 approvals, and slippage protection.
 *  - 1-Click Cross-Chain Buy Planner: automatically detects idle balances across other EVM chains
 *    and formulates an instant 1-click bridge-and-buy route.
 *  - Zero-Loss Guarantee: enforces 20-byte sovereign EOAs, verifies private key derivation,
 *    protects against gas starvation via mandatory native gas reserves, and sets Stargate
 *    refund addresses directly to the user's sovereign address.
 */
import { ethers } from 'ethers';
import {
  createLogger,
  decrypt,
  LZ_CHAINS,
  STARGATE_V2_POOLS,
  STARGATE_V2_POOL_ABI,
  ERC20_ABI,
  getLayerZeroScanUrl,
  verifySovereignEvmWallet,
  buildStargateSendParam,
  quoteStargateSend,
  type LayerZeroChain,
  type StargateAsset,
  type LayerZeroBridgeQuote,
} from '@racerbot/shared';
import { getUserById, getUserByTelegramId, type UserRecord } from '@racerbot/db';

const logger = createLogger('layerzero-bridge');

function getMasterKey(): string {
  return process.env.KEY_ENCRYPTION_MASTER_KEY || process.env.ENCRYPTION_MASTER_KEY || '';
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface EvmChainBalance {
  chain: LayerZeroChain;
  chainName: string;
  icon: string;
  nativeBalance: string;
  nativeBalanceRaw: bigint;
  nativeUsd: number;
  usdcBalance: string;
  usdcBalanceRaw: bigint;
  usdcUsd: number;
  usdtBalance: string;
  usdtBalanceRaw: bigint;
  usdtUsd: number;
  totalUsd: number;
}

export interface CrossChainBalancesResult {
  evmAddress: string;
  balances: Record<LayerZeroChain, EvmChainBalance>;
  totalPortfolioUsd: number;
}

export interface BridgeExecutionResult {
  success: boolean;
  txHash: string;
  lzScanUrl: string;
  sourceChain: LayerZeroChain;
  destChain: LayerZeroChain;
  asset: StargateAsset;
  amount: string;
  minAmountReceived: string;
  nativeFee: string;
  gasPaid: string;
  recipient: string;
  approxDurationSec: number;
  explorerUrl: string;
}

export interface OneClickBuyPlan {
  available: boolean;
  reason?: string;
  targetTokenSymbol: string;
  destChain: LayerZeroChain;
  targetAmountUsd: number;
  fundingChain?: LayerZeroChain;
  fundingAsset?: StargateAsset;
  fundingAmount?: string;
  bridgeFeeUsd?: number;
  bridgeDurationSec?: number;
  quote?: LayerZeroBridgeQuote;
  evmAddress: string;
}

// ── Helper: Get and verify user EVM wallet ──────────────────────────────────

export async function getUserEvmSigner(
  userOrId: string | UserRecord,
  chain: LayerZeroChain,
  customProvider?: ethers.Provider
): Promise<{ wallet: ethers.Wallet; user: UserRecord }> {
  let user: UserRecord | null = null;
  if (typeof userOrId === 'string') {
    user = await getUserById(userOrId);
  } else {
    user = userOrId;
  }

  if (!user || !user.evm_address || !user.evm_private_key_enc) {
    throw new Error('No EVM wallet found for this account. Run /wallet to initialize your unified EVM address.');
  }

  const masterKey = getMasterKey();
  // Enforce sovereign EOA verification
  const check = verifySovereignEvmWallet(user.evm_address, user.evm_private_key_enc, masterKey);
  if (!check.valid) {
    throw new Error(`EVM wallet security check failed: ${check.reason}`);
  }

  const rawKey = decrypt(user.evm_private_key_enc, masterKey);
  const chainConfig = LZ_CHAINS[chain];
  if (!chainConfig) {
    throw new Error(`Unsupported chain: ${chain}`);
  }

  const provider = customProvider || new ethers.JsonRpcProvider(chainConfig.rpcUrls[0]);
  const wallet = new ethers.Wallet(rawKey, provider);
  return { wallet, user };
}

// ── Cross-Chain Balance Scanner ─────────────────────────────────────────────

/**
 * Scans user's balances across all supported LayerZero chains in parallel.
 */
export async function scanCrossChainEvmBalances(
  evmAddress: string,
  ethUsdPrice = 3200
): Promise<CrossChainBalancesResult> {
  const check = verifySovereignEvmWallet(evmAddress);
  if (!check.valid) {
    throw new Error(`Invalid EVM address: ${check.reason}`);
  }
  const cleanAddr = check.address;

  const chains: LayerZeroChain[] = ['arbitrum', 'base', 'optimism', 'ethereum'];
  const balances: Partial<Record<LayerZeroChain, EvmChainBalance>> = {};
  let totalPortfolioUsd = 0;

  await Promise.all(
    chains.map(async (chain) => {
      const config = LZ_CHAINS[chain];
      try {
        const provider = new ethers.JsonRpcProvider(config.rpcUrls[0]);

        // Query Native Balance
        const nativeRaw = await provider.getBalance(cleanAddr).catch(() => 0n);
        const nativeHuman = ethers.formatEther(nativeRaw);
        const nativeUsd = parseFloat(nativeHuman) * ethUsdPrice;

        // Query USDC Balance
        let usdcRaw = 0n;
        const usdcPool = STARGATE_V2_POOLS[chain]?.USDC;
        if (usdcPool && usdcPool.tokenAddress !== ethers.ZeroAddress) {
          const usdcContract = new ethers.Contract(usdcPool.tokenAddress, ERC20_ABI, provider);
          usdcRaw = await usdcContract.balanceOf(cleanAddr).catch(() => 0n);
        }
        const usdcHuman = ethers.formatUnits(usdcRaw, 6);
        const usdcUsd = parseFloat(usdcHuman);

        // Query USDT Balance if pool exists
        let usdtRaw = 0n;
        const usdtPool = STARGATE_V2_POOLS[chain]?.USDT;
        if (usdtPool && usdtPool.tokenAddress !== ethers.ZeroAddress) {
          const usdtContract = new ethers.Contract(usdtPool.tokenAddress, ERC20_ABI, provider);
          usdtRaw = await usdtContract.balanceOf(cleanAddr).catch(() => 0n);
        }
        const usdtHuman = ethers.formatUnits(usdtRaw, 6);
        const usdtUsd = parseFloat(usdtHuman);

        const totalChainUsd = nativeUsd + usdcUsd + usdtUsd;
        totalPortfolioUsd += totalChainUsd;

        balances[chain] = {
          chain,
          chainName: config.name,
          icon: config.icon,
          nativeBalance: nativeHuman,
          nativeBalanceRaw: nativeRaw,
          nativeUsd,
          usdcBalance: usdcHuman,
          usdcBalanceRaw: usdcRaw,
          usdcUsd,
          usdtBalance: usdtHuman,
          usdtBalanceRaw: usdtRaw,
          usdtUsd,
          totalUsd: totalChainUsd,
        };
      } catch (err: any) {
        logger.warn(`Failed to scan balances on ${chain}: ${err.message}`);
        balances[chain] = {
          chain,
          chainName: config.name,
          icon: config.icon,
          nativeBalance: '0.0',
          nativeBalanceRaw: 0n,
          nativeUsd: 0,
          usdcBalance: '0.0',
          usdcBalanceRaw: 0n,
          usdcUsd: 0,
          usdtBalance: '0.0',
          usdtBalanceRaw: 0n,
          usdtUsd: 0,
          totalUsd: 0,
        };
      }
    })
  );

  return {
    evmAddress: cleanAddr,
    balances: balances as Record<LayerZeroChain, EvmChainBalance>,
    totalPortfolioUsd,
  };
}

// ── Bridge Execution ────────────────────────────────────────────────────────

/**
 * Executes a Stargate V2 cross-chain bridge transfer.
 *
 * Guarantees zero-loss:
 *  - Enforces minimum native gas reserve so the source wallet is never bricked.
 *  - Direct on-chain refund address pointing to user's sovereign EOA.
 *  - Slippage enforcement via minAmountLD.
 *  - Pre-flight balance & allowance validation.
 */
export async function executeLayerZeroBridge(params: {
  userId: string;
  sourceChain: LayerZeroChain;
  destChain: LayerZeroChain;
  asset: StargateAsset;
  humanAmount: string;
  recipientAddress?: string;
  slippageBps?: number;
}): Promise<BridgeExecutionResult> {
  const { wallet, user } = await getUserEvmSigner(params.userId, params.sourceChain);
  const sourceConfig = LZ_CHAINS[params.sourceChain];
  const destConfig = LZ_CHAINS[params.destChain];

  const rawRecipient = params.recipientAddress || wallet.address;
  // Verify recipient is a valid 20-byte EVM address (never Starknet/Sui)
  const recipientCheck = verifySovereignEvmWallet(rawRecipient);
  if (!recipientCheck.valid) {
    throw new Error(`Invalid recipient address: ${recipientCheck.reason}`);
  }
  const recipient = recipientCheck.address;

  const poolMap = STARGATE_V2_POOLS[params.sourceChain];
  const poolInfo = poolMap ? poolMap[params.asset] : undefined;
  if (!poolInfo) {
    throw new Error(`Stargate V2 has no pool for ${params.asset} on ${params.sourceChain}`);
  }

  const amountLD = ethers.parseUnits(params.humanAmount, poolInfo.decimals);
  if (amountLD <= 0n) {
    throw new Error('Bridge amount must be greater than zero');
  }

  // Pre-flight 1: Check token balance
  if (params.asset === 'ETH') {
    const nativeBal = await wallet.provider!.getBalance(wallet.address);
    if (nativeBal < amountLD) {
      throw new Error(`Insufficient ETH balance on ${sourceConfig.name}. You have ${ethers.formatEther(nativeBal)} ETH.`);
    }
  } else {
    const tokenContract = new ethers.Contract(poolInfo.tokenAddress, ERC20_ABI, wallet);
    const tokenBal: bigint = await tokenContract.balanceOf(wallet.address);
    if (tokenBal < amountLD) {
      throw new Error(
        `Insufficient ${params.asset} balance on ${sourceConfig.name}. ` +
          `You have ${ethers.formatUnits(tokenBal, poolInfo.decimals)} ${params.asset}, requested ${params.humanAmount}.`
      );
    }
  }

  // Quote Stargate transfer
  const quote = await quoteStargateSend({
    sourceChain: params.sourceChain,
    destChain: params.destChain,
    asset: params.asset,
    humanAmount: params.humanAmount,
    recipientAddress: recipient,
    slippageBps: params.slippageBps,
    provider: wallet.provider!,
  });

  // Pre-flight 2: Check native gas + reserve guard
  const nativeBal = await wallet.provider!.getBalance(wallet.address);
  const requiredNativeGas = quote.nativeFee + quote.sourceGasEstimate;
  const totalRequiredNative = params.asset === 'ETH' ? amountLD + requiredNativeGas : requiredNativeGas;
  const minReserve = sourceConfig.minNativeGasReserve;

  if (nativeBal < totalRequiredNative + minReserve) {
    const neededEther = ethers.formatEther(totalRequiredNative + minReserve);
    const currentEther = ethers.formatEther(nativeBal);
    throw new Error(
      `Insufficient native gas on ${sourceConfig.name} to cover LayerZero fee + gas reserve. ` +
        `Required: ~${neededEther} ${sourceConfig.nativeSymbol} (including safety reserve), Available: ${currentEther} ${sourceConfig.nativeSymbol}. ` +
        `Please deposit gas to your wallet: \`${wallet.address}\``
    );
  }

  // Step 3: Handle ERC20 Approval if needed
  if (params.asset !== 'ETH') {
    const tokenContract = new ethers.Contract(poolInfo.tokenAddress, ERC20_ABI, wallet);
    const currentAllowance: bigint = await tokenContract.allowance(wallet.address, poolInfo.poolAddress);
    if (currentAllowance < amountLD) {
      logger.info(`Approving Stargate V2 pool for ${params.asset} on ${params.sourceChain}...`);
      const approveTx = await tokenContract.approve(poolInfo.poolAddress, ethers.MaxUint256);
      await approveTx.wait(1);
    }
  }

  // Step 4: Execute Stargate V2 send()
  const sendParam = buildStargateSendParam({
    destChain: params.destChain,
    recipientAddress: recipient,
    amountLD,
    slippageBps: params.slippageBps,
  });

  const poolContract = new ethers.Contract(poolInfo.poolAddress, STARGATE_V2_POOL_ABI, wallet);

  // Stargate send value: nativeFee (or nativeFee + amount if sending ETH)
  const sendValue = params.asset === 'ETH' ? quote.nativeFee + amountLD : quote.nativeFee;

  logger.info(`Broadcasting Stargate V2 send on ${params.sourceChain} to ${params.destChain}...`, {
    asset: params.asset,
    amount: params.humanAmount,
    sendValue: sendValue.toString(),
  });

  const messagingFee = [quote.nativeFee, 0n]; // [nativeFee, lzTokenFee]
  const refundAddress = wallet.address; // Critical: Unused gas returns to sovereign EOA

  const tx = await poolContract.send(
    [
      sendParam.dstEid,
      sendParam.to,
      sendParam.amountLD,
      sendParam.minAmountLD,
      sendParam.extraOptions,
      sendParam.composeMsg,
      sendParam.oftCmd,
    ],
    messagingFee,
    refundAddress,
    { value: sendValue }
  );

  const receipt = await tx.wait(1);
  const gasPaid = receipt ? ethers.formatEther(receipt.gasUsed * receipt.gasPrice) : '0';

  return {
    success: true,
    txHash: tx.hash,
    lzScanUrl: getLayerZeroScanUrl(tx.hash),
    sourceChain: params.sourceChain,
    destChain: params.destChain,
    asset: params.asset,
    amount: params.humanAmount,
    minAmountReceived: ethers.formatUnits(sendParam.minAmountLD, poolInfo.decimals),
    nativeFee: quote.humanNativeFee,
    gasPaid,
    recipient,
    approxDurationSec: quote.approxDurationSec,
    explorerUrl: `${sourceConfig.explorerUrl}/tx/${tx.hash}`,
  };
}

// ── 1-Click Cross-Chain Buy Planner ─────────────────────────────────────────

/**
 * Plans a 1-Click cross-chain purchase.
 *
 * When a user attempts to buy a token on `destChain` but has insufficient local balance:
 * 1. Checks available balances across other EVM networks (e.g. Base, Arbitrum).
 * 2. Finds the optimal funding route (preferring USDC or ETH on fast L2s).
 * 3. Pre-calculates Stargate V2 quote and estimated delivery time.
 */
export async function planCrossChain1ClickBuy(params: {
  userId: string;
  destChain: LayerZeroChain;
  targetTokenSymbol: string;
  requiredAmountUsd: number;
}): Promise<OneClickBuyPlan> {
  const user = await getUserById(params.userId);
  if (!user || !user.evm_address) {
    return {
      available: false,
      reason: 'No EVM wallet initialized',
      targetTokenSymbol: params.targetTokenSymbol,
      destChain: params.destChain,
      targetAmountUsd: params.requiredAmountUsd,
      evmAddress: '',
    };
  }

  const portfolio = await scanCrossChainEvmBalances(user.evm_address);
  const candidateChains: LayerZeroChain[] = (['base', 'arbitrum', 'optimism', 'ethereum'] as LayerZeroChain[]).filter(
    (c) => c !== params.destChain
  );

  // Search for sufficient USDC first (most stable & predictable)
  for (const chain of candidateChains) {
    const bal = portfolio.balances[chain];
    if (bal && bal.usdcUsd >= params.requiredAmountUsd + 1.5) {
      // Found funding!
      const quote = await quoteStargateSend({
        sourceChain: chain,
        destChain: params.destChain,
        asset: 'USDC',
        humanAmount: params.requiredAmountUsd.toFixed(2),
        recipientAddress: user.evm_address,
      });

      return {
        available: true,
        targetTokenSymbol: params.targetTokenSymbol,
        destChain: params.destChain,
        targetAmountUsd: params.requiredAmountUsd,
        fundingChain: chain,
        fundingAsset: 'USDC',
        fundingAmount: params.requiredAmountUsd.toFixed(2),
        bridgeFeeUsd: parseFloat(quote.humanNativeFee) * 3200,
        bridgeDurationSec: quote.approxDurationSec,
        quote,
        evmAddress: user.evm_address,
      };
    }
  }

  // Next search for sufficient native ETH
  for (const chain of candidateChains) {
    const bal = portfolio.balances[chain];
    if (bal && bal.nativeUsd >= params.requiredAmountUsd + 5.0) {
      const ethAmount = (params.requiredAmountUsd / 3200).toFixed(4);
      const quote = await quoteStargateSend({
        sourceChain: chain,
        destChain: params.destChain,
        asset: 'ETH',
        humanAmount: ethAmount,
        recipientAddress: user.evm_address,
      });

      return {
        available: true,
        targetTokenSymbol: params.targetTokenSymbol,
        destChain: params.destChain,
        targetAmountUsd: params.requiredAmountUsd,
        fundingChain: chain,
        fundingAsset: 'ETH',
        fundingAmount: ethAmount,
        bridgeFeeUsd: parseFloat(quote.humanNativeFee) * 3200,
        bridgeDurationSec: quote.approxDurationSec,
        quote,
        evmAddress: user.evm_address,
      };
    }
  }

  return {
    available: false,
    reason: `Insufficient balance across all EVM chains. Total portfolio USD: $${portfolio.totalPortfolioUsd.toFixed(2)}`,
    targetTokenSymbol: params.targetTokenSymbol,
    destChain: params.destChain,
    targetAmountUsd: params.requiredAmountUsd,
    evmAddress: user.evm_address,
  };
}
