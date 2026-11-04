/**
 * RacerConnect — Client-side SDK for WebApp <-> Telegram Verified Pairing,
 * Latest NEAR Connect (@hot-labs/near-connect) Integration, and 1.5% Platform Trading Fee Execution.
 *
 * Implements:
 *  1. Telegram DM Security Verification (User inputs @username -> DB check -> Bot pings DM with 6-digit OTP & 1-tap Approve button)
 *  2. Zero-Click Telegram Auth inside Telegram Mini App (TMA via window.Telegram.WebApp.initData)
 *  3. 1-Tap Deep-Link Handshake for Desktop/Mobile Browsers (/start auth_sess_...)
 *  4. Official NEAR Connect (@hot-labs/near-connect) wallet integration:
 *     - Sandboxed, lightweight, zero-dependency wallet execution
 *     - Supports HOT Wallet, Meteor, Intear, MyNearWallet, Nightly, NEAR Mobile, OKX, WalletConnect, etc.
 *     - Direct on-chain transaction signing (signAndSendTransaction, signAndSendTransactions)
 *     - NEP-413 message signing (signMessage)
 *  5. 1.5% Platform Trading Fee calculations & execution routing to treasury (racerbottreasury.near)
 */

(function () {
  const STORAGE_KEY = 'racer_auth_token';
  const USER_KEY = 'racer_user_profile';
  const WALLET_KEY = 'racer_connected_near_wallet';
  const EVM_WALLET_KEY = 'racer_connected_evm_wallet';
  const SOLANA_WALLET_KEY = 'racer_connected_solana_wallet';
  const CHAIN_KEY = 'racer_connected_wallet_chain';
  const PLATFORM_FEE_PCT = 1.5;
  const TREASURY_ACCOUNT = 'racerbottreasury.near';
  const isWalletAuthToken = (token) => /^racer_tok_wallet_[a-f0-9]{40}$/.test(token || '');

  /** Deterministic base58 encoder for Solana signatures */
  function base58Encode(bytes) {
    if (typeof bytes === 'string') return bytes;
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const source = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes || []);
    if (source.length === 0) return '';
    const digits = [0];
    for (let i = 0; i < source.length; i++) {
      for (let j = 0; j < digits.length; j++) digits[j] <<= 8;
      digits[0] += source[i];
      let carry = 0;
      for (let j = 0; j < digits.length; ++j) {
        digits[j] += carry;
        carry = (digits[j] / 58) | 0;
        digits[j] %= 58;
      }
      while (carry) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }
    for (let i = 0; i < source.length && source[i] === 0; i++) digits.push(0);
    return digits.reverse().map(d => ALPHABET[d]).join('');
  }

  /** EVM chains a connected wallet can pay a 1Click deposit on, with the coin it sends natively */
  const EVM_DEPOSIT_CHAINS = {
    eth: { id: 1, name: 'Ethereum', native: 'ETH' },
    base: { id: 8453, name: 'Base', native: 'ETH' },
    arb: { id: 42161, name: 'Arbitrum One', native: 'ETH' },
    bsc: { id: 56, name: 'BNB Chain', native: 'BNB' },
    pol: { id: 137, name: 'Polygon', native: 'POL' },
  };
  const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

  /** Base units of a deposit: the quote's exact raw amount when given, else the decimal amount */
  function baseUnits(amountRaw, amount, decimals) {
    if (amountRaw != null && /^\d+$/.test(String(amountRaw))) return BigInt(String(amountRaw));
    const d = Number.isInteger(decimals) && decimals >= 0 ? decimals : 18;
    const [whole, frac = ''] = String(amount ?? '0').trim().split('.');
    if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return 0n;
    return BigInt(whole || '0') * 10n ** BigInt(d) + BigInt((frac + '0'.repeat(d)).slice(0, d) || '0');
  }

  /** The transaction hash from whatever shape a wallet's signAndSendTransaction returns */
  function txHashOf(outcome) {
    if (typeof outcome === 'string') return outcome;
    if (!outcome || typeof outcome !== 'object') return null;
    return outcome.transaction?.hash || outcome.transaction_outcome?.id || outcome.hash ||
      (Array.isArray(outcome.transactions) ? outcome.transactions[0]?.transaction?.hash : null) || null;
  }

  class RacerConnectClient {
    constructor() {
      this.token = localStorage.getItem(STORAGE_KEY) || null;
      this.activeNearWallet = localStorage.getItem(WALLET_KEY) || null;
      this.activeEvmWallet = localStorage.getItem(EVM_WALLET_KEY) || null;
      this.activeSolanaWallet = localStorage.getItem(SOLANA_WALLET_KEY) || null;
      this.activeWalletChain = localStorage.getItem(CHAIN_KEY) || (this.activeNearWallet ? 'near' : this.activeEvmWallet ? 'evm' : this.activeSolanaWallet ? 'solana' : null);
      this.user = this._loadUser();
      if (this.token?.startsWith('racer_tok_wallet_') && !isWalletAuthToken(this.token)) {
        this.token = null;
        this.user = null;
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(USER_KEY);
      }

      this.pollTimer = null;
      this.vreqTimer = null;
      this.currentSessionId = null;
      this.currentVreqId = null;
      this.nearConnector = null;

      // Real-time synchronization across all tabs and pages
      window.addEventListener('storage', (e) => {
        if (e.key === WALLET_KEY || e.key === EVM_WALLET_KEY || e.key === SOLANA_WALLET_KEY || e.key === CHAIN_KEY || e.key === STORAGE_KEY || e.key === USER_KEY) {
          this.token = localStorage.getItem(STORAGE_KEY) || null;
          this.activeNearWallet = localStorage.getItem(WALLET_KEY) || null;
          this.activeEvmWallet = localStorage.getItem(EVM_WALLET_KEY) || null;
          this.activeSolanaWallet = localStorage.getItem(SOLANA_WALLET_KEY) || null;
          this.activeWalletChain = localStorage.getItem(CHAIN_KEY) || (this.activeNearWallet ? 'near' : this.activeEvmWallet ? 'evm' : this.activeSolanaWallet ? 'solana' : null);
          this.user = this._loadUser();
          if (this.token?.startsWith('racer_tok_wallet_') && !isWalletAuthToken(this.token)) {
            this.token = null;
            localStorage.removeItem(STORAGE_KEY);
          }
          this.dispatchEvent('racer:auth-changed', { authenticated: this.isAuthenticated(), user: this.user });
          this.dispatchEvent('racer:wallet-linked', {
            address: this.activeNearWallet || this.activeEvmWallet || this.activeSolanaWallet,
            chain: this.activeWalletChain,
          });
        }
      });

      // Background initialize NEAR Connect so existing connections are restored instantly
      setTimeout(() => {
        this.initNearConnect(false).catch(() => {});
      }, 300);

      // Auto-detect Telegram Mini App on load
      if (this.isTelegramMiniApp() && !this.token) {
        this.loginWithMiniApp().catch((err) => console.warn('[RacerConnect] TMA auto-login failed:', err));
      } else if (this.token) {
        this.fetchProfile().catch(() => {});
      }
    }

    _loadUser() {
      try {
        const raw = localStorage.getItem(USER_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    }

    isTelegramMiniApp() {
      return Boolean(window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData);
    }

    isAuthenticated() {
      return Boolean(this.token || this.isTelegramMiniApp() || this.activeNearWallet || this.activeEvmWallet || this.activeSolanaWallet);
    }

    getAuthHeader() {
      if (this.token) {
        return { Authorization: `Bearer ${this.token}` };
      }
      if (this.isTelegramMiniApp()) {
        return { Authorization: `tma ${window.Telegram.WebApp.initData}` };
      }
      return {};
    }

    /**
     * Calculate 1.5% platform fee for any trade
     */
    calculateFee(amountNear) {
      const gross = parseFloat(amountNear) || 0;
      const fee = parseFloat((gross * (PLATFORM_FEE_PCT / 100)).toFixed(6));
      const net = parseFloat((gross - fee).toFixed(6));
      return {
        gross,
        feePct: PLATFORM_FEE_PCT,
        fee,
        net,
        treasury: TREASURY_ACCOUNT,
      };
    }

    /**
     * 1. Telegram DM Verification (Security measure: user inputs username, bot verifies in DB & pings DM)
     */
    async requestTelegramVerification(usernameInput, onStatusUpdate) {
      const raw = (usernameInput || '').trim();
      if (!raw) {
        throw new Error('Please enter your Telegram handle (e.g. @username)');
      }

      this.stopVerificationPoll();

      const res = await fetch('/api/auth/telegram/request-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: raw }),
      });

      const data = await res.json();
      if (!data.success || !data.requestId) {
        throw new Error(data.error || 'User not found in RacerBot database.');
      }

      this.currentVreqId = data.requestId;

      // Start polling for approval (in case user clicks [Approve] button in Telegram)
      this.vreqTimer = setInterval(async () => {
        try {
          const checkRes = await fetch(`/api/auth/telegram/status/${this.currentVreqId}`);
          const checkData = await checkRes.json();

          if (checkData.success && checkData.status === 'approved' && checkData.authToken) {
            this.stopVerificationPoll();
            this._setAuth(checkData.authToken, checkData.user);
            if (typeof onStatusUpdate === 'function') {
              onStatusUpdate('approved', checkData.user);
            }
          } else if (checkData.status === 'rejected') {
            this.stopVerificationPoll();
            if (typeof onStatusUpdate === 'function') {
              onStatusUpdate('rejected', { reason: 'Connection rejected in Telegram.' });
            }
          }
        } catch (err) {
          console.warn('[RacerConnect] Verification status poll error:', err);
        }
      }, 2500);

      return {
        requestId: data.requestId,
        maskedHandle: data.maskedHandle,
        demoCodeHint: data.demoCodeHint,
      };
    }

    /**
     * Submit 6-digit OTP code entered by user
     */
    async submitVerificationCode(requestId, code) {
      const res = await fetch('/api/auth/telegram/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, code }),
      });

      const data = await res.json();
      if (!data.success || !data.authToken) {
        throw new Error(data.error || 'Invalid verification code.');
      }

      this.stopVerificationPoll();
      this._setAuth(data.authToken, data.user);
      return data.user;
    }

    stopVerificationPoll() {
      if (this.vreqTimer) {
        clearInterval(this.vreqTimer);
        this.vreqTimer = null;
      }
      this.currentVreqId = null;
    }

    /**
     * 2. Authenticate via Telegram Mini App (Zero-click)
     */
    async loginWithMiniApp() {
      if (!this.isTelegramMiniApp()) {
        throw new Error('Not running inside Telegram Mini App');
      }

      const initData = window.Telegram.WebApp.initData;
      const res = await fetch('/api/auth/tma', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
      });

      const data = await res.json();
      if (!data.success || !data.token) {
        throw new Error(data.error || 'TMA authentication failed');
      }

      this._setAuth(data.token, data.user);
      return data.user;
    }

    /**
     * 3. Start Deep-Link Pairing Handshake for standard web browsers
     */
    async startTelegramPairing(onStatusChange) {
      if (this.isTelegramMiniApp()) {
        return this.loginWithMiniApp();
      }

      this.stopPairing();

      const res = await fetch('/api/auth/session/create', { method: 'POST' });
      const data = await res.json();
      if (!data.success || !data.sessionId) {
        throw new Error(data.error || 'Failed to initialize Telegram session');
      }

      this.currentSessionId = data.sessionId;
      const deepLink = data.deepLink;

      return new Promise((resolve, reject) => {
        let attempts = 0;
        const maxAttempts = 120; // 10 minutes (every 5 seconds)

        this.pollTimer = setInterval(async () => {
          attempts++;
          if (attempts > maxAttempts) {
            this.stopPairing();
            reject(new Error('Pairing session timed out. Please try again.'));
            return;
          }

          try {
            const checkRes = await fetch(`/api/auth/session/${this.currentSessionId}`);
            const checkData = await checkRes.json();

            if (checkData.success && checkData.session?.status === 'linked') {
              const session = checkData.session;
              this.stopPairing();

              const profile = {
                id: session.userId,
                telegramId: session.telegramId,
                username: session.username,
                firstName: session.firstName,
              };

              this._setAuth(session.authToken, profile);
              if (typeof onStatusChange === 'function') {
                onStatusChange('linked', profile);
              }
              resolve({ profile, deepLink });
            } else if (checkData.success && checkData.session?.status === 'expired') {
              this.stopPairing();
              reject(new Error('Login was denied in Telegram.'));
            }
          } catch (pollErr) {
            console.warn('[RacerConnect] Poll error:', pollErr);
          }
        }, 3000);

        if (typeof onStatusChange === 'function') {
          onStatusChange('pending', { deepLink, sessionId: data.sessionId });
        }
      });
    }

    stopPairing() {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      this.currentSessionId = null;
    }

    _setAuth(token, user) {
      this.token = token;
      this.user = user;
      localStorage.setItem(STORAGE_KEY, token);
      if (user) {
        localStorage.setItem(USER_KEY, JSON.stringify(user));
      }
      this.dispatchEvent('racer:auth-changed', { authenticated: true, user });
    }

    logout() {
      this.stopPairing();
      this.stopVerificationPoll();
      if (this.nearConnector) {
        this.nearConnector.disconnect().catch(() => {});
      }
      this.token = null;
      this.user = null;
      this.activeNearWallet = null;
      this.activeEvmWallet = null;
      this.activeSolanaWallet = null;
      this.activeWalletChain = null;
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(USER_KEY);
      localStorage.removeItem(WALLET_KEY);
      localStorage.removeItem(EVM_WALLET_KEY);
      localStorage.removeItem(SOLANA_WALLET_KEY);
      localStorage.removeItem(CHAIN_KEY);
      this.dispatchEvent('racer:auth-changed', { authenticated: false, user: null });
      this.dispatchEvent('racer:wallet-linked', null);
    }

    async fetchProfile() {
      const headers = this.getAuthHeader();
      if (!headers.Authorization) return null;

      try {
        const res = await fetch('/api/auth/me', { headers });
        const data = await res.json();
        if (data.success && data.user) {
          this.user = { ...this.user, ...data.user, wallets: data.wallets, balances: data.balances };
          localStorage.setItem(USER_KEY, JSON.stringify(this.user));
          this.dispatchEvent('racer:profile-updated', this.user);
          return this.user;
        } else if (res.status === 401) {
          this.logout();
        }
      } catch (err) {
        console.warn('[RacerConnect] Failed to fetch profile:', err);
      }
      return null;
    }

    getState() {
      const isLinked = this.isAuthenticated();
      const connectedWallet = this.activeNearWallet || this.activeEvmWallet || this.activeSolanaWallet || (this.user ? (this.user.address || this.user.subaccountId || this.user.evm_address || this.user.solana_address) : null);
      const chain = this.activeWalletChain || (this.activeNearWallet ? 'near' : this.activeEvmWallet ? 'evm' : this.activeSolanaWallet ? 'solana' : 'near');
      return {
        isLinked,
        connectedWallet,
        walletChain: chain,
        subaccount: this.user ? (this.user.subaccountId || this.user.address) : connectedWallet,
        user: this.user,
        token: this.token,
      };
    }

    onStateChange(callback) {
      if (typeof callback === 'function') {
        this.listeners = this.listeners || [];
        this.listeners.push(callback);
        try { callback(this.getState()); } catch (e) {}
        window.addEventListener('racer:auth-changed', () => callback(this.getState()));
        window.addEventListener('racer:wallet-linked', () => callback(this.getState()));
        window.addEventListener('racer:profile-updated', () => callback(this.getState()));
      }
    }

    /**
     * 4. Official NEAR Connect (@hot-labs/near-connect) Integration
     * Loads the latest near-connect runtime and launches the modal popup
     */
    async initNearConnect(showModal = false) {
      // Ensure NEAR Connect bundle is loaded
      if (!window.NearConnector) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = '/assets/near-connect.bundle.js';
          script.onload = resolve;
          script.onerror = () => reject(new Error('Failed to load NEAR Connect bundle'));
          document.head.appendChild(script);
        });
      }

      if (!this.nearConnector && window.NearConnector) {
        try {
          this.nearConnector = new window.NearConnector({
            network: 'mainnet',
            manifest: '/assets/near-connect-manifest.json',
            footerBranding: {
              icon: '/assets/logo.png',
              heading: 'Racer Connect',
              link: 'https://racerbot.io',
              linkText: 'Powered by NEAR Connect',
            },
          });

          // Listen for account sign in
          this.nearConnector.on('wallet:signIn', async (event) => {
            const accounts = event.accounts || [];
            if (accounts.length > 0) {
              const accountId = accounts[0].accountId;
              const walletName = event.wallet?.manifest?.name || 'NEAR Connect';
              console.log('[RacerConnect] NEAR Connect wallet:signIn:', accountId, walletName);
              await this.connectSelectorAccount(accountId, walletName);
            }
          });

          // Listen for sign-in with signed message
          this.nearConnector.on('wallet:signInAndSignMessage', async (event) => {
            const accounts = event.accounts || [];
            if (accounts.length > 0) {
              const accountId = accounts[0].accountId;
              const walletName = event.wallet?.manifest?.name || 'NEAR Connect';
              console.log('[RacerConnect] NEAR Connect wallet:signInAndSignMessage:', accountId, walletName);
              await this.connectSelectorAccount(accountId, walletName);
            }
          });

          this.nearConnector.on('wallet:signOut', () => {
            console.log('[RacerConnect] NEAR Connect wallet:signOut');
            this.logout();
          });

          // Check if wallet is already connected from persistent storage
          try {
            const connected = await this.nearConnector.getConnectedWallet();
            if (connected && connected.accounts && connected.accounts.length > 0) {
              const accountId = connected.accounts[0].accountId;
              const walletName = connected.wallet?.manifest?.name || 'NEAR Connect';
              if (!this.activeNearWallet || this.activeNearWallet !== accountId) {
                console.log('[RacerConnect] Restored session from NearConnector:', accountId, walletName);
                this.activeNearWallet = accountId;
                localStorage.setItem(WALLET_KEY, accountId);
                this.dispatchEvent('racer:wallet-linked', { address: accountId, name: walletName });
              }
            }
          } catch (e) {
            // Not yet connected in NearConnector
          }
        } catch (e) {
          console.warn('[RacerConnect] Error initializing NearConnector:', e);
        }
      }

      if (showModal) {
        if (this.nearConnector) {
          try {
            await this.nearConnector.connect();
          } catch (err) {
            if (err?.message?.includes('User reject') || err?.message?.includes('reject')) {
              console.log('[RacerConnect] User closed NEAR Connect modal');
              return;
            }
            throw err;
          }
        } else {
          console.warn('[RacerConnect] NearConnector not available, opening Racer Connect modal');
          if (typeof window.openConnectModal === 'function') {
            window.openConnectModal();
          } else {
            const modal = document.getElementById('racer-connect-modal');
            if (modal) modal.classList.add('open');
          }
        }
      }
    }

    // Unified launcher for NEAR Connect modal
    async openNearWalletSelector() {
      await this.initNearConnect(true);
      if (!this.nearConnector) {
        if (typeof window.openConnectModal === 'function') {
          window.openConnectModal();
        } else {
          const modal = document.getElementById('racer-connect-modal');
          if (modal) modal.classList.add('open');
        }
      }
    }

    async openNearWallet() {
      await this.openNearWalletSelector();
    }

    async initWalletSelector(showModal = false) {
      await this.initNearConnect(showModal);
    }

    /**
     * NEP-413 Challenge Verification via NEAR Connect
     */
    async signWalletChallenge(accountId) {
      const challengeRes = await fetch('/api/auth/wallet/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId }),
      });
      const challengeData = await challengeRes.json();
      if (!challengeRes.ok || !challengeData.success) {
        throw new Error(challengeData.error || 'Failed to create wallet authentication challenge');
      }

      const wallet = await this.getNearWallet();
      if (!wallet || typeof wallet.signMessage !== 'function') {
        return {
          challengeId: challengeData.challengeId,
          accountId,
          message: challengeData.message,
          nonce: challengeData.nonce,
          recipient: challengeData.recipient,
        };
      }

      const nonceBytes = Uint8Array.from(atob(challengeData.nonce), (c) => c.charCodeAt(0));
      const signed = await wallet.signMessage({
        signerId: accountId,
        accountId,
        message: challengeData.message,
        nonce: nonceBytes,
        recipient: challengeData.recipient,
      });

      return {
        challengeId: challengeData.challengeId,
        accountId,
        message: challengeData.message,
        nonce: challengeData.nonce,
        recipient: challengeData.recipient,
        publicKey: signed?.publicKey || '',
        signature: signed?.signature || '',
      };
    }

    /**
     * Ensure an active connected NEAR wallet has a verified session token
     */
    async ensureWalletSession() {
      if (this.token || this.isTelegramMiniApp()) return true;
      if (!this.activeNearWallet) return false;
      await this.connectSelectorAccount(this.activeNearWallet, "NEAR Connect", true);
      return Boolean(this.token);
    }

    /**
     * Connect or authenticate directly via NEAR Connect
     */
    async connectSelectorAccount(accountId, walletName = 'NEAR Connect', attemptChallenge = true) {
      if (this.isTelegramMiniApp() || (this.token && !this.token.startsWith('racer_tok_wallet_'))) {
        return this.linkSelectorAccount(accountId, walletName);
      }
      try {
        let proof = null;
        if (attemptChallenge) {
          try {
            proof = await this.signWalletChallenge(accountId);
          } catch (signErr) {
            console.warn('[RacerConnect] Challenge signing optional or not supported:', signErr.message);
          }
        }

        if (proof && proof.signature) {
          const res = await fetch('/api/auth/wallet-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountId, walletName, proof }),
          });

          const data = await res.json();
          if (res.ok && data.success && data.authToken && data.user) {
            this.token = data.authToken;
            this.authToken = data.authToken;
            this.user = data.user;
            this.activeNearWallet = accountId;
            this.activeWalletChain = 'near';
            localStorage.setItem(STORAGE_KEY, data.authToken);
            localStorage.setItem(USER_KEY, JSON.stringify(data.user));
            localStorage.setItem(WALLET_KEY, accountId);
            localStorage.setItem(CHAIN_KEY, 'near');

            this.dispatchEvent('racer:auth-changed', { status: 'linked', authenticated: true, user: this.user });
            this.dispatchEvent('racer:wallet-linked', { address: accountId, name: walletName, chain: 'near' });
            return this.user;
          }
        }

        // Wallet connected on-chain without a signed challenge session: keep address without faking a token
        if (!this.user) {
          this.user = {
            id: 'u-wallet-' + accountId.replace(/[^a-zA-Z0-9]/g, '_'),
            username: accountId,
            subaccountId: accountId,
            address: accountId,
          };
          localStorage.setItem(USER_KEY, JSON.stringify(this.user));
        }
        this.activeNearWallet = accountId;
        this.activeWalletChain = 'near';
        localStorage.setItem(WALLET_KEY, accountId);
        localStorage.setItem(CHAIN_KEY, 'near');

        this.dispatchEvent('racer:auth-changed', { status: 'linked', authenticated: true, user: this.user });
        this.dispatchEvent('racer:wallet-linked', { address: accountId, name: walletName, chain: 'near' });
        return this.user;
      } catch (err) {
        console.error('[RacerConnect] Error connecting account:', err);
        this.activeNearWallet = accountId;
        this.activeWalletChain = 'near';
        localStorage.setItem(WALLET_KEY, accountId);
        localStorage.setItem(CHAIN_KEY, 'near');
        this.dispatchEvent('racer:wallet-linked', { address: accountId, name: walletName, chain: 'near' });
      }
    }

    /**
     * Connect EVM Wallet via EIP-4361 SIWE challenge signing
     * Compatible with MetaMask, Rabby, Coinbase, Rainbow, Brave, etc.
     */
    async connectEvmWallet() {
      const ethereum = window.ethereum;
      if (!ethereum) {
        throw new Error('No EVM wallet detected. Please install MetaMask, Rabby, or Coinbase Wallet.');
      }

      const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
      if (!accounts || accounts.length === 0) {
        throw new Error('No accounts selected in EVM wallet.');
      }
      const accountId = accounts[0].toLowerCase();
      const walletName = (ethereum.isRabby ? 'Rabby' : ethereum.isCoinbaseWallet ? 'Coinbase' : ethereum.isMetaMask ? 'MetaMask' : 'EVM Wallet');

      // Request SIWE challenge
      const challengeRes = await fetch('/api/auth/wallet/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, chain: 'evm' }),
      });
      const challenge = await challengeRes.json();
      if (!challengeRes.ok || !challenge.success) {
        throw new Error(challenge.error || 'Failed to create EVM sign-in challenge');
      }

      // Sign challenge using personal_sign
      const signature = await ethereum.request({
        method: 'personal_sign',
        params: [challenge.message, accountId],
      });

      // Submit verified proof
      const proof = {
        challengeId: challenge.challengeId,
        accountId,
        chain: 'evm',
        message: challenge.message,
        nonce: challenge.nonce,
        recipient: challenge.recipient,
        signature,
      };

      const loginRes = await fetch('/api/auth/wallet-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, chain: 'evm', walletName, proof }),
      });
      const loginData = await loginRes.json();
      if (!loginRes.ok || !loginData.success || !loginData.authToken) {
        throw new Error(loginData.error || 'EVM wallet verification failed');
      }

      this.token = loginData.authToken;
      this.authToken = loginData.authToken;
      this.user = loginData.user;
      this.activeEvmWallet = accountId;
      this.activeWalletChain = 'evm';

      localStorage.setItem(STORAGE_KEY, loginData.authToken);
      localStorage.setItem(USER_KEY, JSON.stringify(loginData.user));
      localStorage.setItem(EVM_WALLET_KEY, accountId);
      localStorage.setItem(CHAIN_KEY, 'evm');

      this.dispatchEvent('racer:auth-changed', { status: 'linked', authenticated: true, user: this.user });
      this.dispatchEvent('racer:wallet-linked', { address: accountId, name: walletName, chain: 'evm' });
      return this.user;
    }

    /**
     * Connect Solana Wallet via SIWS challenge signing
     * Compatible with Phantom, Solflare, Backpack, etc.
     */
    async connectSolanaWallet() {
      const solana = window.phantom?.solana || window.solana;
      if (!solana) {
        throw new Error('No Solana wallet detected. Please install Phantom, Solflare, or Backpack.');
      }

      let resp = null;
      if (solana.isConnected && solana.publicKey) {
        resp = { publicKey: solana.publicKey };
      } else {
        resp = await solana.connect();
      }
      const pubkey = resp.publicKey?.toBase58 ? resp.publicKey.toBase58() : resp.publicKey?.toString();
      if (!pubkey) {
        throw new Error('Could not retrieve public key from Solana wallet.');
      }
      const walletName = (solana.isPhantom ? 'Phantom' : solana.isSolflare ? 'Solflare' : 'Solana Wallet');

      // Request SIWS challenge
      const challengeRes = await fetch('/api/auth/wallet/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: pubkey, chain: 'solana' }),
      });
      const challenge = await challengeRes.json();
      if (!challengeRes.ok || !challenge.success) {
        throw new Error(challenge.error || 'Failed to create Solana sign-in challenge');
      }

      // Sign challenge message
      const encodedMsg = new TextEncoder().encode(challenge.message);
      const signed = await solana.signMessage(encodedMsg, 'utf8');
      const rawSig = signed.signature || signed;
      const signatureBase58 = base58Encode(rawSig);

      // Submit verified proof
      const proof = {
        challengeId: challenge.challengeId,
        accountId: pubkey,
        chain: 'solana',
        message: challenge.message,
        nonce: challenge.nonce,
        recipient: challenge.recipient,
        signature: signatureBase58,
      };

      const loginRes = await fetch('/api/auth/wallet-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: pubkey, chain: 'solana', walletName, proof }),
      });
      const loginData = await loginRes.json();
      if (!loginRes.ok || !loginData.success || !loginData.authToken) {
        throw new Error(loginData.error || 'Solana wallet verification failed');
      }

      this.token = loginData.authToken;
      this.authToken = loginData.authToken;
      this.user = loginData.user;
      this.activeSolanaWallet = pubkey;
      this.activeWalletChain = 'solana';

      localStorage.setItem(STORAGE_KEY, loginData.authToken);
      localStorage.setItem(USER_KEY, JSON.stringify(loginData.user));
      localStorage.setItem(SOLANA_WALLET_KEY, pubkey);
      localStorage.setItem(CHAIN_KEY, 'solana');

      this.dispatchEvent('racer:auth-changed', { status: 'linked', authenticated: true, user: this.user });
      this.dispatchEvent('racer:wallet-linked', { address: pubkey, name: walletName, chain: 'solana' });
      return this.user;
    }

    /**
     * Pay a 1Click deposit quote from the connected wallet. Sends exactly the quoted asset on the quoted
     * chain: the chain's native coin, or an ERC-20 transfer on the token contract. Anything else (SPL or
     * NEP-141 tokens, other chains) has to be sent by hand to the copied address.
     */
    async sendConnectedWalletTransfer({ chain, depositAddress, amount, amountRaw, decimals, contract, symbol }) {
      if (!depositAddress) throw new Error('Deposit address is required.');
      const targetChain = (chain || '').toLowerCase();
      const sym = String(symbol || '').toUpperCase();
      const manual = `Sending ${symbol || 'this token'} on ${chain} from the connected wallet is not supported. Copy the deposit address and send it from your wallet.`;

      const evm = EVM_DEPOSIT_CHAINS[targetChain];
      if (evm) {
        if (!window.ethereum) throw new Error('No EVM wallet detected to send transaction.');
        if (!EVM_ADDRESS.test(depositAddress)) throw new Error('This deposit address is not an EVM address.');
        // A token without a contract must be the chain's own coin; never send the coin for a token
        if (contract ? !EVM_ADDRESS.test(contract) : sym !== evm.native) throw new Error(manual);
        const raw = baseUnits(amountRaw, amount, contract ? decimals : 18);
        if (raw <= 0n) throw new Error('The deposit amount is missing.');

        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        const from = accounts && accounts[0];
        if (!from) throw new Error('Please connect your EVM wallet first.');
        // The same address exists on every EVM chain: switch to the quote's chain before sending
        const chainHex = '0x' + evm.id.toString(16);
        const onChain = async () => String(await window.ethereum.request({ method: 'eth_chainId' })).toLowerCase() === chainHex;
        if (!(await onChain())) {
          await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainHex }] });
          if (!(await onChain())) throw new Error(`Switch your wallet to ${evm.name} and try again.`);
        }
        const tx = contract
          ? { from, to: contract, value: '0x0', data: '0xa9059cbb' + depositAddress.slice(2).toLowerCase().padStart(64, '0') + raw.toString(16).padStart(64, '0') }
          : { from, to: depositAddress, value: '0x' + raw.toString(16) };
        const txHash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [tx] });
        return { success: true, txHash, chain: targetChain };
      }

      if (['sol', 'solana'].includes(targetChain)) {
        // Only native SOL: an SPL token needs token accounts this simple transfer does not create
        if (contract || sym !== 'SOL') throw new Error(manual);
        const solana = window.phantom?.solana || window.solana;
        if (!solana) throw new Error('No Solana wallet detected to send transaction.');
        if (!solana.publicKey) await solana.connect();
        const lamports = baseUnits(amountRaw, amount, 9);
        if (lamports <= 0n) throw new Error('The deposit amount is missing.');
        if (!window.solanaWeb3) {
          await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://unpkg.com/@solana/web3.js@1.95.8/lib/index.iife.min.js';
            s.onload = resolve;
            s.onerror = () => reject(new Error('Failed to load Solana Web3 runtime. Please copy deposit address.'));
            document.head.appendChild(s);
          });
        }
        if (!window.solanaWeb3) throw new Error('Failed to load Solana Web3 runtime. Please copy deposit address.');
        const connection = new window.solanaWeb3.Connection('https://api.mainnet-beta.solana.com', 'confirmed');
        const fromPubkey = solana.publicKey;
        const toPubkey = new window.solanaWeb3.PublicKey(depositAddress);
        const tx = new window.solanaWeb3.Transaction().add(
          window.solanaWeb3.SystemProgram.transfer({ fromPubkey, toPubkey, lamports: Number(lamports) })
        );
        const { blockhash } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = fromPubkey;
        const signed = await solana.signAndSendTransaction(tx);
        const txHash = signed.signature || signed;
        return { success: true, txHash, chain: 'solana' };
      }

      // NEAR deposits are wNEAR token transfers, not native NEAR: send those by hand
      throw new Error(manual);
    }

    /**
     * Link an external NEAR account to existing Telegram user
     */
    async linkSelectorAccount(accountId, walletName = 'NEAR Connect') {
      if (!this.isTelegramMiniApp() && (!this.token || this.token.startsWith('racer_tok_wallet_'))) {
        return this.connectSelectorAccount(accountId, walletName);
      }

      const headers = {
        'Content-Type': 'application/json',
        ...this.getAuthHeader(),
      };
      let proof = null;
      try {
        proof = await this.signWalletChallenge(accountId);
      } catch (e) {
        console.warn('[RacerConnect] Challenge proof omitted during link:', e.message);
      }

      const res = await fetch('/api/wallet/link-selector', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          accountId,
          walletName,
          proof,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to link wallet');
      }

      this.activeNearWallet = accountId;
      localStorage.setItem(WALLET_KEY, accountId);

      await this.fetchProfile();
      this.dispatchEvent('racer:wallet-linked', data.wallet);
      return data.wallet;
    }

    /**
     * Return wallet instance from NEAR Connect for direct on-chain signing
     */
    async getNearWallet() {
      if (!this.nearConnector) {
        await this.initNearConnect(false);
      }
      if (this.nearConnector) {
        try {
          return await this.nearConnector.wallet();
        } catch (e) {
          // No wallet connected or not ready
        }
      }
      return null;
    }

    /**
     * Send native NEAR transaction on-chain via connected wallet selector.
     * Prompts the user's wallet (Meteor, HOT, Intear, MyNearWallet, etc.) to approve & sign.
     */
    async sendNearTransaction({ receiverId, amountNear }) {
      if (!this.nearConnector) {
        await this.initNearConnect(false);
      }
      let wallet = await this.getNearWallet();
      if (!wallet || typeof wallet.signAndSendTransaction !== 'function') {
        await this.openNearWalletSelector();
        wallet = await this.getNearWallet();
        if (!wallet || typeof wallet.signAndSendTransaction !== 'function') {
          throw new Error('Please connect your NEAR wallet (Meteor, HOT, Intear, etc.) to approve transaction.');
        }
      }

      const numNear = parseFloat(amountNear);
      if (isNaN(numNear) || numNear <= 0) {
        throw new Error('Invalid NEAR transfer amount.');
      }

      // Convert NEAR to yoctoNEAR (1 NEAR = 10^24 yoctoNEAR)
      const yocto = (BigInt(Math.round(numNear * 1e6)) * 1000000000000000000n).toString();

      const outcome = await wallet.signAndSendTransaction({
        receiverId: receiverId || TREASURY_ACCOUNT,
        actions: [
          {
            type: 'Transfer',
            params: {
              deposit: yocto,
            },
          },
        ],
      });

      const hash = txHashOf(outcome);
      return {
        success: true,
        hash: hash || outcome?.id || outcome,
        txHash: hash || outcome?.id || outcome,
        transaction: { hash: hash || outcome?.id || outcome },
        outcome,
      };
    }

    /**
     * Sign one transaction of function calls with the connected wallet.
     * `actions`: [{ methodName, args, gas, deposit }] with gas and deposit as strings.
     */
    async sendFunctionCalls({ receiverId, actions }) {
      if (!this.nearConnector) {
        await this.initNearConnect(false);
      }
      let wallet = await this.getNearWallet();
      if (!wallet || typeof wallet.signAndSendTransaction !== 'function') {
        await this.openNearWalletSelector();
        wallet = await this.getNearWallet();
        if (!wallet || typeof wallet.signAndSendTransaction !== 'function') {
          throw new Error('Please connect your NEAR wallet (Meteor, HOT, Intear, etc.) to approve transaction.');
        }
      }
      const outcome = await wallet.signAndSendTransaction({
        receiverId,
        actions: actions.map(a => ({
          type: 'FunctionCall',
          params: { methodName: a.methodName, args: a.args || {}, gas: String(a.gas), deposit: String(a.deposit || '0') },
        })),
      });
      const hash = txHashOf(outcome);
      if (!hash) throw new Error('The wallet did not return a transaction hash.');
      return { success: true, hash, txHash: hash, outcome };
    }

    /**
     * 5. Execute Swap or Copy Trade with 1.5% Platform Fee
     */
    async executeTrade({ tokenAddress, tokenOut, amountNear, amountIn, isCopyTrade = false, traderId = null }) {
      if (!this.isAuthenticated()) {
        throw new Error('Please connect your NEAR wallet or Telegram account to trade.');
      }

      const targetToken = tokenAddress || tokenOut || 'blackdragon.tkn.near';
      const rawAmount = amountNear || amountIn || 1.0;
      const feeDetails = this.calculateFee(rawAmount);
      const endpoint = isCopyTrade ? '/api/alpha/copy-trade' : '/api/swap';

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.getAuthHeader(),
        },
        body: JSON.stringify({
          tokenAddress: targetToken,
          amountNear: feeDetails.gross,
          traderId,
          walletAddress: this.activeNearWallet || (this.user ? this.user.subaccountId : null),
        }),
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Trade execution failed.');
      }

      return {
        ...data,
        feeDetails,
      };
    }

    dispatchEvent(name, detail) {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    }
  }

  // Expose singleton to window
  window.RacerConnect = new RacerConnectClient();
})();
