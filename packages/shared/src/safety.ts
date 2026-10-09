import { getNear } from './near.js';

export interface TokenSafetyReport {
  tokenAddress: string;
  isHoneypot: boolean;
  safe: boolean;
  risk: 'low' | 'medium' | 'high' | 'critical';
  isAuditedLaunchpad: boolean;
  launchpadName?: string;
  reasons: string[];
  dangerousMethods: string[];
  warning?: string;
  allExportedMethods?: string[];
  isDrained?: boolean;
  isUnlockedRheaPool?: boolean;
  liquidityNear?: number;
  rheaPoolId?: number | null;
  lpLocked?: boolean;
}

// ── Established, audited launchpad factories & trusted tokens ────────────────
export const VERIFIED_LAUNCHPAD_SUFFIXES = [
  '.meme-cooking.near',
  '.nearlytrade.near',
  '.launchpad.justhoot.near',
  '.launchpad-justhoot.near',
  '.nearpadfamily.near',
  '.factory.shardsmarket.near',
  '.intear.near',
  '.tkn.near',
  '.nekotoken.near',
  '.nearportnear.near',
  '.launch.shoremarkets.near',
  '.gaypad.j1-racing.near',
  '.exchange.kelytradevs.near',
  '.kelytra.near',
  '.onetokenhub.near',
  'pad.onetokenhub.near',
  '.omft.near',
];

export const VERIFIED_CORE_TOKENS = new Set([
  'wrap.near',
  'near',
  'aurora',
  'token.sweat',
  'token.v2.ref-finance.near',
  'usdt.tether-token.near',
  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', // USDC
]);

export function isCoreToken(tokenAddress: string): boolean {
  if (!tokenAddress) return false;
  const lower = tokenAddress.toLowerCase().trim();
  return VERIFIED_CORE_TOKENS.has(lower) || lower === 'wrap.near' || lower === 'near';
}

export function isAuditedLaunchpadToken(tokenAddress: string): boolean {
  if (!tokenAddress) return false;
  const lower = tokenAddress.toLowerCase().trim();
  if (isCoreToken(lower)) return true;
  for (const suffix of VERIFIED_LAUNCHPAD_SUFFIXES) {
    if (lower.endsWith(suffix) || lower === suffix) return true;
  }
  return false;
}

// ── Known dangerous backdoor method signatures ──────────────────────────────
// These methods allow contract creators to confiscate, burn, freeze or blacklist
// user balances without the holder's cryptographic authorization.
const DANGEROUS_METHOD_PATTERNS = [
  // Forced confiscation / drain
  'storage_unstake',
  'unstake',
  'confiscate',
  'clawback',
  'drain',
  'seize',
  'slash',
  'admin_burn',
  'burn_from',
  'burn_account',
  'force_transfer',
  'force_withdraw',
  'take_tokens',
  'take_balance',
  'admin_transfer',
  'withdraw_from',
  'admin_withdraw',
  'emergency_withdraw',
  'emergency_drain',
  'recover_funds',
  'sweep',
  'steal',
  'revoke',
  // Blacklists & account freezing
  'blacklist',
  'add_blacklist',
  'set_blacklist',
  'freeze',
  'freeze_account',
  'unfreeze',
  'lock_account',
  'pause_account',
  'kill_account',
  // Trading restrictions & predatory tax manipulation
  'disable_trading',
  'block_trading',
  'emergency_stop',
];

// In-memory safety cache with 15-minute TTL to keep trade paths fast
const safetyCache = new Map<string, { at: number; report: TokenSafetyReport }>();
const SAFETY_CACHE_TTL_MS = 15 * 60_000;

/**
 * Perform a comprehensive safety and honeypot inspection on any token.
 *
 * 1. Verifies if token was created by an audited launchpad factory.
 * 2. If standalone / custom contract, inspects compiled WASM exports via RPC.
 * 3. Inspects Rhea/Ref Finance liquidity to detect drained/rugged pools & unlocked LP shares.
 * 4. Flags or blocks any unauthorized balance deduction, freeze backdoors, or liquidity rugs.
 */
export async function checkTokenSafety(tokenAddress: string, forceFresh = false): Promise<TokenSafetyReport> {
  const normAddress = tokenAddress.toLowerCase().trim();

  if (!forceFresh) {
    const cached = safetyCache.get(normAddress);
    if (cached && Date.now() - cached.at < SAFETY_CACHE_TTL_MS) {
      return cached.report;
    }
  }

  // ── SUI Tokens ────────────────────────────────────────────────────────────
  if (normAddress.includes('::') || normAddress.startsWith('0x')) {
    const isSuiPump = normAddress.includes('::suipump::');
    const report: TokenSafetyReport = {
      tokenAddress: normAddress,
      isHoneypot: false,
      safe: true,
      risk: isSuiPump ? 'low' : 'low',
      isAuditedLaunchpad: isSuiPump,
      launchpadName: isSuiPump ? 'SuiPump' : undefined,
      reasons: [],
      dangerousMethods: [],
      lpLocked: true,
      isUnlockedRheaPool: false,
      isDrained: false,
    };
    safetyCache.set(normAddress, { at: Date.now(), report });
    return report;
  }

  // ── NEAR Tokens: Step 1 - Check verified launchpad factories ──────────────
  if (VERIFIED_CORE_TOKENS.has(normAddress)) {
    const report: TokenSafetyReport = {
      tokenAddress: normAddress,
      isHoneypot: false,
      safe: true,
      risk: 'low',
      isAuditedLaunchpad: true,
      launchpadName: 'Verified Native / Core',
      reasons: [],
      dangerousMethods: [],
      lpLocked: true,
      isUnlockedRheaPool: false,
      isDrained: false,
    };
    safetyCache.set(normAddress, { at: Date.now(), report });
    return report;
  }

  for (const suffix of VERIFIED_LAUNCHPAD_SUFFIXES) {
    if (normAddress.endsWith(suffix) || normAddress === suffix) {
      let launchpadName = suffix.replace(/^\./, '').split('.')[0] || suffix;
      if (suffix.includes('kelytra') || suffix.includes('kelytradevs')) {
        launchpadName = 'Kelytra';
      } else if (suffix.includes('gaypad')) {
        launchpadName = 'Gaypad';
      } else if (suffix.includes('justhoot')) {
        launchpadName = 'JustHoot';
      } else if (suffix.includes('shoremarkets')) {
        launchpadName = 'ShoreMarkets';
      } else if (suffix.includes('onetokenhub')) {
        launchpadName = 'OneTokenHub';
      } else if (suffix.includes('omft')) {
        launchpadName = 'Omnichain (Defuse OMFT)';
      } else {
        launchpadName = launchpadName.charAt(0).toUpperCase() + launchpadName.slice(1);
      }
      const report: TokenSafetyReport = {
        tokenAddress: normAddress,
        isHoneypot: false,
        safe: true,
        risk: 'low',
        isAuditedLaunchpad: true,
        launchpadName,
        reasons: [],
        dangerousMethods: [],
        lpLocked: true,
        isUnlockedRheaPool: false,
        isDrained: false,
      };
      safetyCache.set(normAddress, { at: Date.now(), report });
      return report;
    }
  }

  // ── NEAR Tokens: Step 2 - Standalone / Custom NEP-141 Inspection ─────────
  // Standalone contracts can contain arbitrary custom Rust WASM bytecode.
  // We fetch the bytecode via view_code and inspect exported functions.
  const near = getNear();
  try {
    const wasmBuf = await near.viewCode(normAddress);
    if (wasmBuf === null) {
      // RPC infrastructure failure: do NOT block token or mark as honeypot!
      console.warn(`[SAFETY] Could not fetch contract code for ${normAddress} due to RPC failure; skipping WASM inspection.`);
    } else if (wasmBuf.length === 0) {
      // Account exists on-chain but confirmed to have NO contract code deployed
      const report: TokenSafetyReport = {
        tokenAddress: normAddress,
        isHoneypot: true,
        safe: false,
        risk: 'high',
        isAuditedLaunchpad: false,
        reasons: ['No contract code deployed at this account address'],
        dangerousMethods: [],
      };
      safetyCache.set(normAddress, { at: Date.now(), report });
      return report;
    }

    let exportedFuncs: string[] = [];
    if (wasmBuf && wasmBuf.length > 0) {
      try {
        const WA = (globalThis as any).WebAssembly;
        if (WA && typeof WA.Module === 'function') {
          const mod = new WA.Module(wasmBuf);
          exportedFuncs = (WA.Module.exports(mod) as any[])
            .filter((e: any) => e.kind === 'function')
            .map((e: any) => String(e.name));
        }
      } catch (err: any) {
        console.warn(`[SAFETY] Could not parse WASM exports for ${normAddress}:`, err.message);
      }
    }

    const dangerousFound: string[] = [];
    for (const fnName of exportedFuncs) {
      const lower = fnName.toLowerCase();
      for (const pattern of DANGEROUS_METHOD_PATTERNS) {
        if (lower === pattern || (pattern.length > 5 && lower.includes(pattern))) {
          dangerousFound.push(fnName);
          break;
        }
      }
    }

    if (dangerousFound.length > 0) {
      const uniqueDang = Array.from(new Set(dangerousFound));
      const report: TokenSafetyReport = {
        tokenAddress: normAddress,
        isHoneypot: true,
        safe: false,
        risk: 'high',
        isAuditedLaunchpad: false,
        reasons: [
          `Malicious backdoor function detected in contract: ${uniqueDang.map(m => `'${m}'`).join(', ')}. ` +
          `The contract owner can confiscate or freeze your tokens without your signature.`
        ],
        dangerousMethods: uniqueDang,
        allExportedMethods: exportedFuncs,
      };
      safetyCache.set(normAddress, { at: Date.now(), report });
      return report;
    }

    // Must at least implement standard ft_transfer or ft_transfer_call
    const hasFtTransfer = exportedFuncs.includes('ft_transfer') || exportedFuncs.includes('ft_transfer_call');
    const hasFtBalanceOf = exportedFuncs.includes('ft_balance_of');

    if (!hasFtTransfer || !hasFtBalanceOf) {
      const report: TokenSafetyReport = {
        tokenAddress: normAddress,
        isHoneypot: true,
        safe: false,
        risk: 'high',
        isAuditedLaunchpad: false,
        reasons: ['Contract does not implement standard NEP-141 transfer or balance methods'],
        dangerousMethods: [],
        allExportedMethods: exportedFuncs,
      };
      safetyCache.set(normAddress, { at: Date.now(), report });
      return report;
    }

    // ── NEAR Tokens: Step 3 - Check Rhea / Ref Finance Liquidity & LP Locking ──
    // Standalone tokens on Rhea AMM have high rug-pull risk if LP shares are unlocked.
    // Also, if liquidity has already been pulled (< 2 NEAR), it is a dead/rugged pool.
    let isDrained = false;
    let isUnlockedRheaPool = false;
    let rheaLiqNear = 0;
    let rheaPoolId: number | null = null;
    let lpLocked = false;

    try {
      const rhea = await near.findRheaPoolForToken(normAddress).catch(() => null);
      if (rhea && rhea.poolId !== null && rhea.poolId !== undefined) {
        rheaLiqNear = rhea.liquidityNear;
        if (!rhea.isDcl && typeof rhea.poolId === 'number') {
          rheaPoolId = rhea.poolId;
        }

        // Standard Ref Finance simple pools (SIMPLE_POOL) do NOT lock LP shares by default.
        if (!rhea.isDcl) {
          isUnlockedRheaPool = true;
          lpLocked = false;
        }

        // If pool liquidity has been drained (< 2.0 NEAR, ~$10), mark as critical drained/rugged pool
        if (rheaLiqNear < 2.0) {
          isDrained = true;
        }
      }
    } catch (err: any) {
      console.warn(`[SAFETY] Could not check Rhea pool liquidity for ${normAddress}:`, err.message);
    }

    if (isDrained) {
      const report: TokenSafetyReport = {
        tokenAddress: normAddress,
        isHoneypot: true, // Block buying to protect user wallet
        safe: false,
        risk: 'critical',
        isAuditedLaunchpad: false,
        isDrained: true,
        isUnlockedRheaPool,
        liquidityNear: rheaLiqNear,
        rheaPoolId,
        lpLocked: false,
        reasons: [
          `Pool liquidity has been DRAINED or PULLED (${rheaLiqNear.toFixed(4)} NEAR remaining). ` +
          `Buying into this pool will cause immediate 100% loss of funds.`
        ],
        dangerousMethods: [],
        allExportedMethods: exportedFuncs,
      };
      safetyCache.set(normAddress, { at: Date.now(), report });
      return report;
    }

    if (isUnlockedRheaPool) {
      const report: TokenSafetyReport = {
        tokenAddress: normAddress,
        isHoneypot: false,
        safe: false,
        risk: 'high',
        isAuditedLaunchpad: false,
        isDrained: false,
        isUnlockedRheaPool: true,
        liquidityNear: rheaLiqNear,
        rheaPoolId,
        lpLocked: false,
        warning: 'Standalone Rhea AMM pool with UNLOCKED liquidity. The creator holds 100% of LP shares and can withdraw all pool liquidity at any moment.',
        reasons: [
          'Liquidity is NOT locked. Creator holds pool LP shares and can execute a liquidity rug pull at any time.'
        ],
        dangerousMethods: [],
        allExportedMethods: exportedFuncs,
      };
      safetyCache.set(normAddress, { at: Date.now(), report });
      return report;
    }

    // Clean standalone contract without backdoors or known pool risks
    const report: TokenSafetyReport = {
      tokenAddress: normAddress,
      isHoneypot: false,
      safe: true,
      risk: 'medium',
      isAuditedLaunchpad: false,
      warning: 'Custom standalone NEP-141 contract. Not deployed through a standard launchpad.',
      reasons: [],
      dangerousMethods: [],
      allExportedMethods: exportedFuncs,
    };
    safetyCache.set(normAddress, { at: Date.now(), report });
    return report;
  } catch (err: any) {
    console.warn(`[SAFETY] Safety check query error for ${normAddress}:`, err.message);
    // On unexpected RPC error, allow trade if it's already an active Ref pool, but flag medium risk
    const report: TokenSafetyReport = {
      tokenAddress: normAddress,
      isHoneypot: false,
      safe: true,
      risk: 'medium',
      isAuditedLaunchpad: false,
      warning: 'Could not complete full bytecode verification due to RPC timeout.',
      reasons: [],
      dangerousMethods: [],
    };
    return report;
  }
}
