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
  ELYSIUM_TESTNET_EXPLORER_URL,
  HYPE_SYMBOL,
} from '@racerbot/shared';
import {
  getUserById,
  createFill,
  getOpenPositions,
  createPosition,
  recordFee,
} from '@racerbot/db';

const MASTER_KEY = process.env.KEY_ENCRYPTION_MASTER_KEY || '';
export const DEFAULT_EVM_TREASURY_ADDRESS = '0xb1f9551E64e1addF18462B09f04E14DC131451b1';
const EVM_TREASURY_ADDRESS = process.env.EVM_TREASURY_ADDRESS || process.env.TREASURY_EVM_ADDRESS || DEFAULT_EVM_TREASURY_ADDRESS;

// Default Verified Routers
export const HYPEREVM_DEFAULT_ROUTER = process.env.HYPEREVM_ROUTER_ADDRESS || '0x1111111254fb6c44bac0bed2854e76f90643097d';
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
  const chain: EvmChain = event.chain || (event.token_out?.toLowerCase().endsWith('.elysium') ? 'elysium' : 'hyperevm');
  const isTestnet = process.env.NODE_ENV !== 'production' || chain === 'elysium';
  const { user_id, token_in, token_out, amount_in, slippage_pct = 2 } = event;

  onProgress?.(`routing_${chain}`);

  const user = await getUserById(user_id);
  if (!user) {
    throw new Error(`User not found: ${user_id}`);
  }

  if (!user.evm_address || !user.evm_private_key_enc) {
    throw new Error(`User ${user_id} does not have an initialized EVM wallet.`);
  }

  const provider = getEvmProvider(chain, isTestnet);
  const signer = getEvmWalletFromEncrypted(user.evm_private_key_enc, MASTER_KEY, provider);

  const isBuy = token_in.toUpperCase() === HYPE_SYMBOL || token_in === 'native' || token_in === ethers.ZeroAddress;
  const targetTokenAddress = isBuy ? token_out : token_in;

  const tokenInfo = await getErc20TokenInfo(targetTokenAddress, chain, isTestnet);
  const tokenSymbol = tokenInfo?.symbol || 'TKN';
  const tokenName = tokenInfo?.name || 'EVM Token';
  const tokenDecimals = tokenInfo?.decimals || 18;

  const routerAddress = chain === 'elysium' ? ELYSIUM_MARKET_LAB_ROUTER : HYPEREVM_DEFAULT_ROUTER;

  // Pre-flight Honeypot Simulation Check
  onProgress?.('simulating');
  const sim = await simulateEvmTrade(targetTokenAddress, routerAddress, user.evm_address, chain, isTestnet);
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

    const totalHypeIn = ethers.parseEther(String(amount_in));
    const { feeAmount, netTradeAmount } = calculateEvmTradeFee(totalHypeIn);

    // Check user's native HYPE balance
    const userBalance = await provider.getBalance(user.evm_address);
    if (userBalance < totalHypeIn) {
      return {
        txHash: '',
        success: false,
        chain,
        reason: `Insufficient HYPE balance. Have ${ethers.formatEther(userBalance)} HYPE, required ${amount_in} HYPE.`,
        tokenSymbol,
        tokenName,
      };
    }

    // Transfer Platform Fee to Treasury if configured
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

    onProgress?.('executing_swap');
    const router = new ethers.Contract(routerAddress, UNISWAP_V2_ROUTER_ABI, signer);
    const wethAddress = await router.WETH().catch(() => ethers.ZeroAddress);
    const path = [wethAddress, targetTokenAddress];

    // Estimate output amount
    let expectedTokensOut = 0n;
    try {
      const amountsOut = await router.getAmountsOut(netTradeAmount, path);
      expectedTokensOut = amountsOut[1] || 0n;
    } catch {
      // Fallback estimate if pool quote reverted
      expectedTokensOut = 1000n * BigInt(10 ** tokenDecimals);
    }

    const minTokensOut = calculateSlippageMin(expectedTokensOut, slippage_pct);
    const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min deadline

    const tx = await router.swapExactETHForTokens(
      minTokensOut,
      path,
      user.evm_address,
      deadline,
      { value: netTradeAmount }
    );

    const receipt = await tx.wait(1);
    const txHash = receipt?.hash || tx.hash;

    // Read new token balance
    const balanceResult = await getErc20Balance(targetTokenAddress, user.evm_address, chain, isTestnet);
    const tokensBought = balanceResult.formatted;
    const priceHype = Number(amount_in) / (balanceResult.human || 1);

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
        input_amount: totalHypeIn.toString(),
        venue: `${chain}_dex` as any,
        tx_hash: txHash,
      }).catch(() => null);

      if (fill?.fillId && fill.inserted) {
        await recordFee(fill.fillId, ethers.formatEther(feeAmount)).catch(() => {});
      }
    }

    const baseExplorer = chain === 'elysium' ? ELYSIUM_TESTNET_EXPLORER_URL : HYPEREVM_EXPLORER_URL;

    return {
      txHash,
      success: true,
      chain,
      positionId: position?.id,
      tokenName,
      tokenSymbol,
      tokenQty: tokensBought,
      priceHype,
      hypeSpentOrReceived: Number(amount_in),
      explorerUrl: `${baseExplorer}/tx/${txHash}`,
    };
  } else {
    // ── SELL: Token -> Native HYPE ─────────────────────────────────────────
    onProgress?.('preparing_sell');

    const tokenContract = new ethers.Contract(targetTokenAddress, ERC20_ABI, signer);
    const tokenDec = await tokenContract.decimals().catch(() => 18);
    const sellQtyRaw = ethers.parseUnits(String(amount_in), tokenDec);

    // Verify token balance
    const currentBalance = await tokenContract.balanceOf(user.evm_address);
    if (currentBalance < sellQtyRaw) {
      return {
        txHash: '',
        success: false,
        chain,
        reason: `Insufficient token balance. You hold ${ethers.formatUnits(currentBalance, tokenDec)} ${tokenSymbol}.`,
        tokenSymbol,
        tokenName,
      };
    }

    // Check & Approve Allowance
    const currentAllowance = await tokenContract.allowance(user.evm_address, routerAddress);
    if (currentAllowance < sellQtyRaw) {
      onProgress?.('approving');
      const approveTx = await tokenContract.approve(routerAddress, ethers.MaxUint256);
      await approveTx.wait(1);
    }

    onProgress?.('executing_swap');
    const router = new ethers.Contract(routerAddress, UNISWAP_V2_ROUTER_ABI, signer);
    const wethAddress = await router.WETH().catch(() => ethers.ZeroAddress);
    const path = [targetTokenAddress, wethAddress];

    let expectedHypeOut = 0n;
    try {
      const amountsOut = await router.getAmountsOut(sellQtyRaw, path);
      expectedHypeOut = amountsOut[1] || 0n;
    } catch {
      expectedHypeOut = ethers.parseEther('0.1');
    }

    const minHypeOut = calculateSlippageMin(expectedHypeOut, slippage_pct);
    const deadline = Math.floor(Date.now() / 1000) + 300;

    const tx = await router.swapExactTokensForETH(
      sellQtyRaw,
      minHypeOut,
      path,
      user.evm_address,
      deadline
    );

    const receipt = await tx.wait(1);
    const txHash = receipt?.hash || tx.hash;

    const receivedHype = parseFloat(ethers.formatEther(expectedHypeOut));
    const priceHype = receivedHype / (parseFloat(String(amount_in)) || 1);

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
        amount: String(amount_in),
        price: priceHype.toString(),
        fee_paid: '0',
        input_amount: expectedHypeOut.toString(),
        venue: `${chain}_dex` as any,
        tx_hash: txHash,
      }).catch(() => null);

      if (fill?.fillId && fill.inserted) {
        await recordFee(fill.fillId, '0').catch(() => {});
      }
    }

    const baseExplorer = chain === 'elysium' ? ELYSIUM_TESTNET_EXPLORER_URL : HYPEREVM_EXPLORER_URL;

    return {
      txHash,
      success: true,
      chain,
      positionId: pos?.id,
      tokenName,
      tokenSymbol,
      tokenQty: String(amount_in),
      priceHype,
      hypeSpentOrReceived: receivedHype,
      explorerUrl: `${baseExplorer}/tx/${txHash}`,
    };
  }
}
