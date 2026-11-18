/**
 * EVM wallets in the bot: HyperEVM, Elysium and Kleos share one EVM key, so a user's
 * EVM wallet is one address used on both chains. Users can import their own key (or
 * seed phrase), switch between EVM wallets and export the active one.
 *
 * Sends are strict: an EVM asset only goes to a plain 20-byte 0x address. Starknet and
 * Sui addresses (also 0x, but longer), NEAR accounts, Solana addresses, bad checksums,
 * the zero address, the user's own wallet and token contracts are all refused.
 */
import { sealCustodyKey } from './keyCustody.js';
import { ethers } from 'ethers';
import {
  encrypt,
  isSolanaAddress,
  getEvmProvider,
  getEvmWalletFromEncrypted,
  toTokenUnits,
  ERC20_ABI,
  elysiumInboxMaxFeePerGas,
  sendElysiumTransaction,
  getEvmNativeSymbol,
  type EvmChain,
} from '@racerbot/shared';
import {
  getUserByTelegramId,
  getUserWallets,
  addEvmWallet,
  setActiveEvmWallet,
  type UserRecord,
  type UserWalletRecord,
} from '@racerbot/db';
import { sendSecurityAlert } from './securityAlerts.js';

function getMasterKey(): string {
  return process.env.KEY_ENCRYPTION_MASTER_KEY || process.env.ENCRYPTION_MASTER_KEY || '';
}
export const MAX_EVM_WALLETS_PER_USER = 5;

/** Gas for the HyperEVM transaction that posts an Elysium call into the inbox */
/** Gas an inbox-delivered Elysium token transfer is given; unused gas is refunded */
const ELYSIUM_TOKEN_TRANSFER_GAS = 150_000n;
const HYPEREVM_TOKEN_TRANSFER_GAS = 120_000n;

/**
 * Restores an EVM wallet from a private key (64 hex characters, with or without 0x)
 * or a 12/24-word seed phrase (first account, m/44'/60'/0'/0/0, as MetaMask uses).
 */
export function parseEvmSecret(input: string): ethers.HDNodeWallet | ethers.Wallet {
  const text = input.trim();
  const words = text.split(/\s+/);
  if (words.length === 12 || words.length === 15 || words.length === 18 || words.length === 21 || words.length === 24) {
    try {
      return ethers.Wallet.fromPhrase(words.join(' ').toLowerCase());
    } catch {
      throw new Error('That seed phrase is not valid. Check the words and their order.');
    }
  }
  const hex = text.startsWith('0x') || text.startsWith('0X') ? text.slice(2) : text;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'That is not an EVM private key. Send the 64-character hex key from MetaMask/Rabby ' +
      '(Account details → Show private key) or your 12/24-word seed phrase.'
    );
  }
  try {
    return new ethers.Wallet('0x' + hex.toLowerCase());
  } catch {
    throw new Error('That private key is not valid.');
  }
}

/**
 * Why an address cannot receive HYPE or HyperEVM/Elysium tokens, or null when it can.
 * EVM addresses are exactly 0x + 40 hex characters; anything else belongs to another chain.
 */
export function evmRecipientProblem(dest: string, ownAddress?: string | null): string | null {
  const d = (dest || '').trim();
  if (/^0x[0-9a-fA-F]{41,64}$/.test(d)) {
    return 'That looks like a Starknet or Sui address (longer than 40 hex characters). EVM ' +
      'funds can only go to an EVM address: 0x followed by exactly 40 hex characters, like a MetaMask or Rabby address. ' +
      'Sending there would lose the funds.';
  }
  if (/\.near$/i.test(d) || /^[0-9a-f]{64}$/i.test(d)) {
    return 'That is a NEAR account. EVM funds can only go to an EVM address (0x + 40 hex characters).';
  }
  if (!d.startsWith('0x') && isSolanaAddress(d)) {
    return 'That is a Solana address. EVM funds can only go to an EVM address (0x + 40 hex characters).';
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(d)) {
    return 'That is not an EVM address. It must be 0x followed by exactly 40 hex characters.';
  }
  if (!ethers.isAddress(d)) {
    return 'That address fails its checksum, which usually means a typo. Copy it again from the receiving wallet.';
  }
  if (d.toLowerCase() === ethers.ZeroAddress) {
    return 'That is the zero address. Anything sent there is burned.';
  }
  if (ownAddress && d.toLowerCase() === ownAddress.toLowerCase()) {
    return 'That is your own RacerBot EVM wallet.';
  }
  return null;
}

export async function listUserEvmWallets(userId: string): Promise<UserWalletRecord[]> {
  return getUserWallets(userId, 'hyperevm');
}

async function importEvmWalletImpl(
  telegramId: number,
  secretInput: string,
  walletName: string,
  setAsActive = true
): Promise<{ wallet: UserWalletRecord; address: string }> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('User not found. Run /start first.');

  const restored = parseEvmSecret(secretInput);
  const address = restored.address;
  const existing = await listUserEvmWallets(user.id);
  const duplicate = existing.find(w => w.address.toLowerCase() === address.toLowerCase());
  if (duplicate) throw new Error(`This EVM wallet is already added as "${duplicate.name}".`);
  if (existing.length >= MAX_EVM_WALLETS_PER_USER) {
    throw new Error(`You have reached the maximum of ${MAX_EVM_WALLETS_PER_USER} EVM wallets.`);
  }

  const wallet = await addEvmWallet({
    userId: user.id,
    address,
    name: walletName.trim().slice(0, 30) || `EVM Wallet ${existing.length + 1}`,
    // Encrypted by the signer when it holds the keys
    encryptedPrivateKey: await sealCustodyKey('evm', restored.privateKey),
    isImported: true,
    isActive: setAsActive,
  });
  return { wallet, address };
}

export async function switchActiveEvmWallet(telegramId: number, walletId: string): Promise<UserWalletRecord> {
  const user = await getUserByTelegramId(telegramId);
  if (!user) throw new Error('User not found. Run /start first.');
  return setActiveEvmWallet(user.id, walletId);
}

const isContract = async (provider: ethers.Provider, address: string) => {
  const code = await provider.getCode(address).catch(() => '0x');
  return Boolean(code && code !== '0x');
};

export interface EvmTokenSendPlan {
  chain: EvmChain;
  token: string;
  symbol: string;
  decimals: number;
  amountRaw: bigint;
  amountDisplay: string;
  to: string;
}

/**
 * Checks an ERC-20 send before anything is signed: the token must be a contract the
 * wallet holds on HyperEVM or Elysium, the recipient must be a plain wallet address
 * (not a token contract: the usual mistake when address and token are swapped), and
 * the amount must fit the balance.
 */
export async function planEvmTokenSend(
  user: UserRecord,
  tokenInput: string,
  to: string,
  amount: number | 'all',
  preferredChain?: EvmChain
): Promise<EvmTokenSendPlan> {
  if (!user.evm_address) throw new Error('Your EVM wallet is not ready yet. Send /start and try again.');
  const problem = evmRecipientProblem(to, user.evm_address);
  if (problem) throw new Error(problem);
  if (!ethers.isAddress(tokenInput)) throw new Error('The token must be its 0x contract address (40 hex characters).');
  const token = ethers.getAddress(tokenInput);
  const recipient = ethers.getAddress(to);
  if (token === recipient) throw new Error('The destination is the token contract itself. Tokens sent there are lost.');

  const providers: Record<EvmChain, ethers.JsonRpcProvider> = {
    hyperevm: getEvmProvider('hyperevm', process.env.HYPEREVM_TESTNET === 'true'),
    elysium: getEvmProvider('elysium', false),
    base: getEvmProvider('base', false),
    arbitrum: getEvmProvider('arbitrum', false),
    ethereum: getEvmProvider('ethereum', false),
    zero: getEvmProvider('zero', false),
  };
  // If a specific chain was selected, check that chain; otherwise scan all supported EVM chains
  const chainsToCheck: EvmChain[] = preferredChain
    ? [preferredChain]
    : ['base', 'arbitrum', 'zero', 'hyperevm', 'elysium', 'ethereum'];
  for (const chain of chainsToCheck) {
    const provider = providers[chain];
    if (!(await isContract(provider, token))) continue;
    const erc20 = new ethers.Contract(token, ERC20_ABI, provider);
    const [balance, decimals, symbol] = await Promise.all([
      erc20.balanceOf(user.evm_address).then((v: bigint) => v).catch(() => 0n),
      erc20.decimals().then((v: bigint) => Number(v)).catch(() => 18),
      erc20.symbol().then((v: string) => String(v)).catch(() => 'TOKEN'),
    ]);
    if (balance <= 0n) continue;
    if (await isContract(provider, recipient)) {
      throw new Error(
        `The destination is a contract on ${chain}, not a wallet. Please enter a valid recipient wallet address.`
      );
    }
    const amountRaw = amount === 'all' ? balance : toTokenUnits(amount, decimals);
    if (amountRaw <= 0n) throw new Error('Amount must be greater than 0.');
    if (amountRaw > balance) {
      throw new Error(`You hold ${ethers.formatUnits(balance, decimals)} ${symbol} on ${chain}.`);
    }
    return { chain, token, symbol, decimals, amountRaw, amountDisplay: ethers.formatUnits(amountRaw, decimals), to: recipient };
  }
  throw new Error('Your EVM wallet holds none of that token across supported EVM chains. Check the token address.');
}

/** Sends a planned ERC-20 transfer directly on the target EVM chain (or HyperEVM inbox when targeting Elysium with ELYSIUM_SEND_MODE=inbox) */
export async function sendEvmTokenImpl(user: UserRecord, plan: EvmTokenSendPlan): Promise<{ txHash: string; elysiumTxHash?: string; viaInbox?: boolean }> {
  if (!user.evm_address || !user.evm_private_key_enc) throw new Error('EVM wallet not configured.');
  // Re-check right before signing: the plan may have waited on a confirm button
  const problem = evmRecipientProblem(plan.to, user.evm_address);
  if (problem) throw new Error(problem);

  const data = new ethers.Interface(ERC20_ABI).encodeFunctionData('transfer', [plan.to, plan.amountRaw]);

  if (plan.chain !== 'elysium') {
    const isTestnet = plan.chain === 'hyperevm' ? (process.env.HYPEREVM_TESTNET === 'true') : false;
    const provider = getEvmProvider(plan.chain, isTestnet);
    const signer = getEvmWalletFromEncrypted(user.evm_private_key_enc, getMasterKey(), provider);
    const nativeBal = await provider.getBalance(user.evm_address);
    const nativeSym = getEvmNativeSymbol(plan.chain);
    const minGas = plan.chain === 'ethereum' ? ethers.parseEther('0.003') : ethers.parseEther('0.0005');
    if (nativeBal < minGas) {
      throw new Error(`You need a little ${nativeSym} on ${plan.chain} (about ${ethers.formatEther(minGas)}) for gas.`);
    }
    const tx = await signer.sendTransaction({ to: plan.token, data, gasLimit: HYPEREVM_TOKEN_TRANSFER_GAS });
    const receipt = await tx.wait(1);
    if (receipt?.status !== 1) throw new Error('The token transfer reverted. Nothing was sent.');
    return { txHash: receipt.hash };
  }

  const elysium = getEvmProvider('elysium', false);
  const hyperevm = getEvmProvider('hyperevm', process.env.HYPEREVM_TESTNET === 'true');
  const l1Signer = getEvmWalletFromEncrypted(user.evm_private_key_enc, getMasterKey(), hyperevm);
  const l2Signer = getEvmWalletFromEncrypted(user.evm_private_key_enc, getMasterKey(), elysium);
  const [l2Balance, l2Block] = await Promise.all([elysium.getBalance(user.evm_address), elysium.getBlock('latest')]);
  const maxFeePerGas = elysiumInboxMaxFeePerGas(l2Block?.baseFeePerGas ?? 0n);
  if (l2Balance < ELYSIUM_TOKEN_TRANSFER_GAS * maxFeePerGas) {
    throw new Error('You need a little HYPE on Elysium for gas before sending tokens there.');
  }
  const sent = await sendElysiumTransaction({
    elysium, l2Signer, l1Signer, hyperevm, tx: { to: plan.token, data }, inboxGasLimit: ELYSIUM_TOKEN_TRANSFER_GAS,
  });
  return { txHash: sent.inboxTxHash ?? sent.elysiumTxHash, elysiumTxHash: sent.elysiumTxHash, viaInbox: Boolean(sent.inboxTxHash) };
}

/** Sends a planned ERC-20 transfer (through the signer when configured) and alerts the owner */
export async function sendEvmToken(user: UserRecord, plan: EvmTokenSendPlan): ReturnType<typeof sendEvmTokenImpl> {
  const { runMoneyOut } = await import('./moneyOut.js');
  return runMoneyOut('evm_token', user, [plan]);
}

/** Imports an EVM wallet and alerts the owner in Telegram */
export async function importEvmWallet(...args: Parameters<typeof importEvmWalletImpl>): ReturnType<typeof importEvmWalletImpl> {
  const res = await importEvmWalletImpl(...args);
  void sendSecurityAlert({ telegramId: args[0] }, {
    kind: 'wallet_import', chain: 'EVM (HyperEVM · Elysium · Kleos)', address: res.address, active: args[3] ?? true,
  });
  return res;
}
