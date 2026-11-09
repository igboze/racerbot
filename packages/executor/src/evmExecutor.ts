import 'dotenv/config';
import { ethers } from 'ethers';
import {
  type EvmChain,
  type SwapEvent,
  getEvmProvider,
  getEvmWalletFromEncrypted,
  getErc20TokenInfo,
  getErc20Balance,
  calculateEvmTradeFee,
  calculateSlippageMin,
  simulateEvmTrade,
  ERC20_ABI,
  UNISWAP_V2_ROUTER_ABI,
  HYPEREVM_EXPLORER_URL,
  HYPE_SYMBOL,
  HYPERSWAP_V2_ROUTER,
  resolveV2Router,
  toTokenUnits,
  distributeTradeFeeRewards,
} from '@racerbot/shared';
import {
  getUserById,
  getActiveWallet,
  createFill,
  getOpenPositions,
  createPosition,
  recordFee,
} from '@racerbot/db';
import { executeKleosSwap } from './kleosExecutor.js';

const MASTER_KEY = process.env.KEY_ENCRYPTION_MASTER_KEY || '';
export const DEFAULT_EVM_TREASURY_ADDRESS = '0xb1f9551E64e1addF18462B09f04E14DC131451b1';
const EVM_TREASURY_ADDRESS = process.env.EVM_TREASURY_ADDRESS || process.env.TREASURY_EVM_ADDRESS || DEFAULT_EVM_TREASURY_ADDRESS;

// Default Verified Routers. HyperEVM swaps use the V2 router interface, so the default is HyperSwap V2;
// a configured router that is not V2 (e.g. a V3 SwapRouter) falls back to it at runtime.
export const HYPEREVM_DEFAULT_ROUTER = process.env.HYPEREVM_ROUTER_ADDRESS || HYPERSWAP_V2_ROUTER;
export const ELYSIUM_MARKET_LAB_ROUTER = process.env.ELYSIUM_ROUTER_ADDRESS || '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
export const ELYSIUM_COREPAD_ROUTER = process.env.ELYSIUM_COREPAD_ROUTER || '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';

export interface EvmSwapExecutionResult {
  txHash: string;
  success: boolean;
  chain: EvmChain;
  positionId?: string;
  reason?: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenQty?: string;
  priceHype?: number;
  hypeSpentOrReceived?: number;
  explorerUrl?: string;
}

/**
 * Execute Buy or Sell Swap on HyperEVM or Elysium L2.
 * Includes honeypot simulation, slippage protection, and 1.5% platform fee collection.
 */
export async function executeEvmSwap(
  event: SwapEvent & { chain?: EvmChain },
  onProgress?: (stage: string) => void
): Promise<EvmSwapExecutionResult> {
  // Kleos, RonsPad and Ascend coins live on Elysium mainnet and trade through their launchpads' routers
  if (event.venue === 'kleos' || event.venue === 'ronspad' || event.venue === 'ascend') return executeKleosSwap(event, EVM_TREASURY_ADDRESS, onProgress);
  const chain: EvmChain = event.chain || (event.token_out?.toLowerCase().endsWith('.elysium') ? 'elysium' : 'hyperevm');
  // Non-Kleos Elysium tokens only exist on the Kinetiq testnet, which RacerBot does not trade
  if (chain === 'elysium') {
    throw new Error('RacerBot trades Kleos, RonsPad and Ascend coins on Elysium. This token is not one of them.');
  }
  const isTestnet = process.env.HYPEREVM_TESTNET === 'true';
  const { user_id, token_in, token_out, amount_in, slippage_pct = 2 } = event;

  onProgress?.(`routing_${chain}`);

  const user = await getUserById(user_id);
  if (!user) {
    throw new Error(`User not found: ${user_id}`);
  }

  const activeWallet = await getActiveWallet(user.id, chain).catch(() => null);
  const userAddress = activeWallet?.address || user.evm_address;
  const userKeyEnc = activeWallet?.encrypted_private_key || user.evm_private_key_enc;

  if (!userAddress || !userKeyEnc) {
    throw new Error(`User ${user_id} does not have an initialized EVM wallet.`);
  }

  const provider = getEvmProvider(chain, isTestnet);
  const signer = getEvmWalletFromEncrypted(userKeyEnc, MASTER_KEY, provider);

  const isBuy = token_in.toUpperCase() === HYPE_SYMBOL || token_in === 'native' || token_in === ethers.ZeroAddress;
  const targetTokenAddress = isBuy ? token_out : token_in;

  const tokenInfo = await getErc20TokenInfo(targetTokenAddress, chain, isTestnet);
  const tokenSymbol = tokenInfo?.symbol || 'TKN';
  const tokenName = tokenInfo?.name || 'EVM Token';
  const tokenDecimals = tokenInfo?.decimals || 18;

  let routerAddress: string;
  let wethAddress: string;
  try {
    ({ address: routerAddress, weth: wethAddress } = await resolveV2Router(
      chain, isTestnet, HYPEREVM_DEFAULT_ROUTER));
  } catch (err: any) {
    return { txHash: '', success: false, chain, reason: `No DEX router available on ${chain}: ${err?.message}`, tokenSymbol, tokenName };
  }
  const noPool = (): EvmSwapExecutionResult => ({
    txHash: '', success: false, chain, tokenSymbol, tokenName,
    reason: `No HyperSwap V2 pool with HYPE liquidity for ${tokenSymbol} yet. Nothing was spent.`,
  });

  // Pre-flight Honeypot Simulation Check
  onProgress?.('simulating');
  const sim = await simulateEvmTrade(targetTokenAddress, routerAddress, userAddress, chain, isTestnet);
  if (!sim.isSafe) {
    return {
      txHash: '',
      success: false,
      chain,
      reason: sim.reason || 'Token failed security simulation (potential honeypot).',
      tokenSymbol,
      tokenName,
    };
  }

  if (isBuy) {
    // ── BUY: Native HYPE -> Token ──────────────────────────────────────────
    onProgress?.('preparing_buy');

    const requestedHypeIn = ethers.parseEther(String(amount_in));
    const gasReserve = ethers.parseEther('0.002'); // Auto-reserve 0.002 HYPE for gas
    const userBalance = await provider.getBalance(userAddress);

    if (userBalance < requestedHypeIn) {
      return {
        txHash: '',
        success: false,
        chain,
        reason: `Insufficient HYPE balance. Have ${ethers.formatEther(userBalance)} HYPE, required ${amount_in} HYPE.`,
        tokenSymbol,
        tokenName,
      };
    }

    // If user's balance is barely enough for the requested swap + gas, adjust net trade amount slightly
    let actualHypeIn = requestedHypeIn;
    if (userBalance < requestedHypeIn + gasReserve && userBalance > gasReserve) {
      actualHypeIn = userBalance - gasReserve;
    }

    const { feeAmount, netTradeAmount } = calculateEvmTradeFee(actualHypeIn);

    onProgress?.('executing_swap');
    const router = new ethers.Contract(routerAddress, UNISWAP_V2_ROUTER_ABI, signer);
    const path = [wethAddress, targetTokenAddress];

    // Quote before anything is sent: no pool means no trade (and no fee)
    let expectedTokensOut = 0n;
    try {
      const amountsOut = await router.getAmountsOut(netTradeAmount, path);
      expectedTokensOut = amountsOut[1] || 0n;
    } catch {
      return noPool();
    }
    if (expectedTokensOut <= 0n) return noPool();

    const minTokensOut = calculateSlippageMin(expectedTokensOut, slippage_pct);
    const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min deadline
    const before = await getErc20Balance(targetTokenAddress, userAddress, chain, isTestnet);

    // Fee-on-transfer variant: also works for meme tokens that tax transfers
    const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
      minTokensOut,
      path,
      userAddress,
      deadline,
      { value: netTradeAmount }
    );

    const receipt = await tx.wait(1);
    const txHash = receipt?.hash || tx.hash;

    // Platform fee to the treasury, only once the swap went through
    if (EVM_TREASURY_ADDRESS && ethers.isAddress(EVM_TREASURY_ADDRESS) && feeAmount > 0n) {
      try {
        const feeTx = await signer.sendTransaction({
          to: EVM_TREASURY_ADDRESS,
          value: feeAmount,
        });
        await feeTx.wait(1);
      } catch (err: any) {
        console.warn(`[EVM_EXECUTOR] Treasury fee transfer non-fatal warning:`, err?.message);
      }
    }

    // What this buy added (the wallet may already have held some)
    const after = await getErc20Balance(targetTokenAddress, userAddress, chain, isTestnet);
    const boughtRaw = after.raw > before.raw ? after.raw - before.raw : after.raw;
    const tokensBought = ethers.formatUnits(boughtRaw, tokenDecimals);
    const priceHype = Number(ethers.formatEther(netTradeAmount)) / (Number(tokensBought) || 1);

    // Record position in DB
    const openPositions = await getOpenPositions(user.id);
    let position = openPositions.find((p) => p.token_address === targetTokenAddress && p.chain === (chain as any));
    if (!position) {
      position = await createPosition({
        user_id: user.id,
        chain: chain as any,
        token_address: targetTokenAddress,
        quantity_held: '0',
        avg_entry_price: '0',
      }).catch(() => null) as any;
    }

    if (position) {
      const fill = await createFill({
        user_id: user.id,
        position_id: position.id,
        chain: chain as any,
        side: 'buy',
        token_address: targetTokenAddress,
        amount: tokensBought,
        price: priceHype.toString(),
        fee_paid: ethers.formatEther(feeAmount),
        input_amount: ethers.formatEther(actualHypeIn),
        venue: `${chain}_dex` as any,
        tx_hash: txHash,
      }).catch(() => null);

      if (fill?.fillId && fill.inserted) {
        const feeHype = ethers.formatEther(feeAmount);
        await recordFee(fill.fillId, feeHype).catch(() => {});
        await distributeTradeFeeRewards({
          userId: user.id,
          chain,
          feeAmount: feeHype,
          tokenAddress: targetTokenAddress,
        }).catch((err) => console.warn('[EVM_EXECUTOR] Fee distribution error:', err?.message));
      }
    }

    const baseExplorer = HYPEREVM_EXPLORER_URL;

    return {
      txHash,
      success: true,
      chain,
      positionId: position?.id,
      tokenName,
      tokenSymbol,
      tokenQty: tokensBought,
      priceHype,
      hypeSpentOrReceived: Number(ethers.formatEther(actualHypeIn)),
      explorerUrl: `${baseExplorer}/tx/${txHash}`,
    };
  } else {
    // ── SELL: Token -> Native HYPE ─────────────────────────────────────────
    onProgress?.('preparing_sell');

    const tokenContract = new ethers.Contract(targetTokenAddress, ERC20_ABI, signer);
    const tokenDec = Number(await tokenContract.decimals().catch(() => 18));
    let sellQtyRaw = toTokenUnits(amount_in, tokenDec);

    // Verify token balance
    const currentBalance: bigint = await tokenContract.balanceOf(userAddress);
    if (currentBalance <= 0n) {
      return { txHash: '', success: false, chain, reason: `No ${tokenSymbol} left in your wallet to sell.`, tokenSymbol, tokenName };
    }
    // The bot's record can sit slightly above the wallet (transfer taxes): sell what is
    // really there instead of failing, which matters most for stop-losses
    if (currentBalance < sellQtyRaw) sellQtyRaw = currentBalance;
    if (sellQtyRaw <= 0n) {
      return { txHash: '', success: false, chain, reason: 'Sell amount must be greater than 0.', tokenSymbol, tokenName };
    }
    const soldQty = ethers.formatUnits(sellQtyRaw, tokenDec);

    const router = new ethers.Contract(routerAddress, UNISWAP_V2_ROUTER_ABI, signer);
    const path = [targetTokenAddress, wethAddress];

    // Quote before approving or sending anything
    let expectedHypeOut = 0n;
    try {
      const amountsOut = await router.getAmountsOut(sellQtyRaw, path);
      expectedHypeOut = amountsOut[1] || 0n;
    } catch {
      return noPool();
    }
    if (expectedHypeOut <= 0n) return noPool();

    // Check & Approve Allowance
    const currentAllowance = await tokenContract.allowance(userAddress, routerAddress);
    if (currentAllowance < sellQtyRaw) {
      onProgress?.('approving');
      const approveTx = await tokenContract.approve(routerAddress, ethers.MaxUint256);
      await approveTx.wait(1);
    }

    onProgress?.('executing_swap');
    const minHypeOut = calculateSlippageMin(expectedHypeOut, slippage_pct);
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const hypeBefore = await provider.getBalance(userAddress);

    // Fee-on-transfer variant: also works for meme tokens that tax transfers
    const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      sellQtyRaw,
      minHypeOut,
      path,
      userAddress,
      deadline
    );

    const receipt = await tx.wait(1);
    const txHash = receipt?.hash || tx.hash;

    // HYPE received = balance change plus the swap's gas; the quote is only the fallback
    const hypeAfter: bigint | null = await provider.getBalance(userAddress).catch(() => null);
    const gasPaid: bigint = receipt ? BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice ?? 0n) : 0n;
    const receivedRaw = hypeAfter !== null && hypeAfter + gasPaid > hypeBefore ? hypeAfter + gasPaid - hypeBefore : expectedHypeOut;
    const receivedHype = parseFloat(ethers.formatEther(receivedRaw));
    const priceHype = receivedHype / (parseFloat(soldQty) || 1);

    // Update position in DB via createFill
    const openPositions = await getOpenPositions(user.id);
    const pos = openPositions.find((p) => p.token_address === targetTokenAddress && p.chain === (chain as any));
    if (pos) {
      const fill = await createFill({
        user_id: user.id,
        position_id: pos.id,
        chain: chain as any,
        side: 'sell',
        token_address: targetTokenAddress,
        amount: soldQty,
        price: priceHype.toString(),
        fee_paid: '0',
        input_amount: ethers.formatEther(receivedRaw),
        venue: `${chain}_dex` as any,
        tx_hash: txHash,
      }).catch(() => null);

      if (fill?.fillId && fill.inserted) {
        await recordFee(fill.fillId, '0').catch(() => {});
      }
    }

    const baseExplorer = HYPEREVM_EXPLORER_URL;

    return {
      txHash,
      success: true,
      chain,
      positionId: pos?.id,
      tokenName,
      tokenSymbol,
      tokenQty: soldQty,
      priceHype,
      hypeSpentOrReceived: receivedHype,
      explorerUrl: `${baseExplorer}/tx/${txHash}`,
    };
  }
}
