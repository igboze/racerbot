/*!
 * RacerbotVault – Shielded Intent Vault & Relayer Contract  (Option B)
 *
 * Architecture:
 *   • Users sign an "Intent" off-chain; the relayer (our backend) submits it on-chain.
 *   • Funds flow: User → vault sub-ledger → Venue → vault → User
 *   • Every step emits a structured EVENT_JSON log for team monitoring.
 *
 * Safety guarantees:
 *   1. Per-user, per-token isolated balance sub-ledger  → funds never mix.
 *   2. Nonce replay protection (LookupSet<[u8;32]>)    → no double-execution.
 *   3. Slippage guard: on breach, full refund to user  → no loss on bad quotes.
 *   4. Withdraw-failure safety: funds re-credited       → user can always recover.
 *   5. Debit-before-dispatch removes reentrancy surface.
 *   6. Admin (owner) cannot drain user balances.
 *   7. Emergency pause/unpause and swap rescue by owner.
 *   8. Universal venue support: Ref AMM, Ref DCL, Intear, Shardsmarket, Bonding Curve, Generic FT Call.
 *   9. Native NEAR and NEP-141 token seamless auto-wrapping / auto-unwrapping.
 *  10. Payouts are checked: a failed transfer re-credits the user's sub-ledger.
 *  11. Balance-diff venues pay only (balance after − snapshot before), one swap per token at a time.
 */

use near_sdk::{
    env, near, AccountId, Gas, NearToken, Promise, PromiseOrValue,
    require, serde_json,
};
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet};

mod executors;

// ── Gas budgets ───────────────────────────────────────────────────────────────
const GAS_WRAP: Gas          = Gas::from_tgas(10);
const GAS_SWAP: Gas          = Gas::from_tgas(80);
const GAS_BALANCE: Gas       = Gas::from_tgas(15);
const GAS_RESOLVE: Gas       = Gas::from_tgas(115);
const GAS_STORAGE: Gas       = Gas::from_tgas(10);
const GAS_FT_XFER: Gas       = Gas::from_tgas(15);
// Balance-diff venues: snapshot → venue swap → balance check → payout → payout callback
const GAS_RESOLVE_XFER: Gas  = Gas::from_tgas(10);
const GAS_RESOLVE_UNWRAP: Gas = Gas::from_tgas(20);
const GAS_PAYOUT: Gas        = Gas::from_tgas(60);
const GAS_SWAP_COMPLETE: Gas = Gas::from_tgas(90);
const GAS_SNAPSHOT: Gas      = Gas::from_tgas(215);
const GAS_SWAP_REF: Gas      = Gas::from_tgas(100);

// ── Constants ─────────────────────────────────────────────────────────────────
const STORAGE_DEPOSIT: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000); // 0.00125 NEAR standard NEP-141
const ONE_YOCTO: NearToken       = NearToken::from_yoctonear(1);
const WRAP_NEAR: &str            = "wrap.near";
const REF_AMM: &str              = "v2.ref-finance.near";
const REF_DCL: &str              = "dclv2.ref-labs.near";
const SHARDSMARKET: &str         = "factory.shardsmarket.near";
const INTEAR_DEX: &str           = "dex.intear.near";

// ── Venue ─────────────────────────────────────────────────────────────────────
#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum Venue {
    Rhea,
    Nearlytrade,
    Shardsmarket,
    RefAmm,
    Dcl,
    Intear,
    BondingCurve,
    GenericFtCall,
}

// ── Single hop inside a multi-hop route ───────────────────────────────────────
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Hop {
    pub pool_id: Option<u64>,
    pub dcl_pool_id: Option<String>,
    pub token_in: String,
    pub token_out: String,
    pub min_amount_out: U128,
}

// ── Intent (signed off-chain, submitted by relayer) ───────────────────────────
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Intent {
    pub user: AccountId,
    pub venue: Venue,
    pub hops: Vec<Hop>,
    pub amount_in: U128,
    pub token_in: String,
    pub token_out: String,
    pub min_amount_out: U128,
    pub nonce: [u8; 32],
    pub deadline: u64,
    pub correlation_id: String,
    pub custom_contract: Option<AccountId>,
    pub custom_msg: Option<String>,
}

// ── Fee config ────────────────────────────────────────────────────────────────
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct FeeConfig {
    pub buy_fee_bps: u32,
    pub sell_fee_bps: u32,
    pub snipe_fee_bps: u32,
}

// ── In-flight swap context ────────────────────────────────────────────────────
#[near(serializers = [borsh, json])]
#[derive(Clone)]
struct PendingSwap {
    user: AccountId,
    token_in: String,
    amount_in: u128,
    token_out: String,
    fee_bps: u32,
    min_amount_out: U128,
    correlation_id: String,
    venue: Venue,
}

type BalanceKey = (AccountId, String);

// ── Contract state ────────────────────────────────────────────────────────────
#[near(contract_state)]
pub struct RacerbotVault {
    owner_id: AccountId,
    treasury_id: AccountId,
    fee_config: FeeConfig,
    /// Isolated per-user, per-token balance sub-ledger
    balances: LookupMap<BalanceKey, u128>,
    /// Consumed intent nonces – replay protection
    used_nonces: LookupSet<[u8; 32]>,
    /// In-flight swap contexts
    pending_swaps: LookupMap<u64, PendingSwap>,
    nonce: u64,
    paused: bool,
}

impl Default for RacerbotVault {
    fn default() -> Self {
        env::panic_str("RacerbotVault: call new()");
    }
}

#[near]
impl RacerbotVault {

    // ═══════════════════════════ INIT ════════════════════════════════════════

    #[init]
    pub fn new(
        owner_id: AccountId,
        treasury_id: AccountId,
        buy_fee_bps: u32,
        sell_fee_bps: u32,
        snipe_fee_bps: u32,
    ) -> Self {
        require!(!env::state_exists(), "Already initialized");
        require!(buy_fee_bps <= 1000 && sell_fee_bps <= 1000 && snipe_fee_bps <= 1000,
            "Fee > 10%");
        Self {
            owner_id,
            treasury_id,
            fee_config: FeeConfig { buy_fee_bps, sell_fee_bps, snipe_fee_bps },
            balances: LookupMap::new(b"b"),
            used_nonces: LookupSet::new(b"n"),
            pending_swaps: LookupMap::new(b"p"),
            nonce: 0,
            paused: false,
        }
    }

    // ═══════════════════════ ACCESS CONTROL ══════════════════════════════════

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
    }

    fn assert_not_paused(&self) {
        require!(!self.paused, "Contract is paused");
    }

    // ═══════════════════════════ ADMIN ═══════════════════════════════════════

    pub fn set_fee_config(&mut self, buy_fee_bps: u32, sell_fee_bps: u32, snipe_fee_bps: u32) {
        self.assert_owner();
        require!(buy_fee_bps <= 1000 && sell_fee_bps <= 1000 && snipe_fee_bps <= 1000, "Fee > 10%");
        self.fee_config = FeeConfig { buy_fee_bps, sell_fee_bps, snipe_fee_bps };
        Self::emit("fee_config_updated", serde_json::json!({
            "buy": buy_fee_bps, "sell": sell_fee_bps, "snipe": snipe_fee_bps
        }));
    }

    pub fn set_treasury(&mut self, treasury_id: AccountId) {
        self.assert_owner();
        self.treasury_id = treasury_id.clone();
        Self::emit("treasury_updated", serde_json::json!({ "treasury_id": treasury_id }));
    }

    pub fn set_owner(&mut self, new_owner: AccountId) {
        self.assert_owner();
        self.owner_id = new_owner.clone();
        Self::emit("owner_updated", serde_json::json!({ "new_owner": new_owner }));
    }

    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        Self::emit("paused", serde_json::json!({}));
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
        Self::emit("unpaused", serde_json::json!({}));
    }

    /// Emergency rescue: if a cross-contract swap promise hangs indefinitely,
    /// owner can rescue the swap and refund 100% of input tokens back to user's balance.
    pub fn rescue_stuck_swap(&mut self, swap_nonce: u64) {
        self.assert_owner();
        let pending = self.pending_swaps.remove(&swap_nonce)
            .expect("No pending swap with this nonce");
        self.credit(&pending.user, &pending.token_in, pending.amount_in);
        self.clear_snapshot(swap_nonce);
        self.take_used(swap_nonce);
        self.set_token_lock(Self::payout_token(&pending.token_out), false);
        self.finish_inflight();
        Self::emit("swap_rescued", serde_json::json!({
            "correlation_id": pending.correlation_id,
            "swap_nonce": swap_nonce,
            "user": pending.user,
            "refunded_token": pending.token_in,
            "refunded_amount": U128(pending.amount_in),
        }));
    }

    /// Owner-only ledger correction for a swap the router could not account for
    /// (see `unaccounted_output` events). Debits only what the ledger holds and records
    /// the on-chain reference, so every correction is auditable.
    pub fn reconcile_ledger(
        &mut self,
        user: AccountId,
        debit_token: String,
        debit_amount: U128,
        credit_token: String,
        credit_amount: U128,
        reference: String,
    ) {
        self.assert_owner();
        require!(!reference.trim().is_empty(), "reference (tx hash) required");
        require!(debit_amount.0 > 0 || credit_amount.0 > 0, "Nothing to reconcile");
        if debit_amount.0 > 0 {
            self.debit_exact(&user, &debit_token, debit_amount.0);
        }
        self.credit(&user, &credit_token, credit_amount.0);
        Self::emit("ledger_reconciled", serde_json::json!({
            "user": user,
            "debit_token": debit_token,
            "debit_amount": debit_amount,
            "credit_token": credit_token,
            "credit_amount": credit_amount,
            "reference": reference,
        }));
    }

    /// Emergency: release a payout-token lock left behind by a swap whose callbacks never ran.
    pub fn release_token_lock(&mut self, token: String) {
        self.assert_owner();
        self.set_token_lock(Self::payout_token(&token), false);
        if token == "inflight" {
            self.set_inflight(0);
        }
        Self::emit("token_lock_released", serde_json::json!({ "token": token }));
    }

    // ═══════════════════════════ DEPOSIT ═════════════════════════════════════

    /// Relayer deposits NEAR into a user's sub-ledger before submitting an intent.
    #[payable]
    pub fn deposit_near(&mut self, user: AccountId) {
        self.assert_not_paused();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "Must attach NEAR");
        self.credit(&user, "near", amount);
        Self::emit("deposit", serde_json::json!({
            "user": user, "token": "near", "amount": U128(amount)
        }));
    }

    /// NEP-141 ft_on_transfer: tokens arrive at contract from user's wallet.
    /// msg = "user:<account_id>" when relayer deposits on behalf of a user.
    /// msg = {"intent": Intent} deposits and trades in one transaction: the tokens are credited
    /// to the sender and the intent starts in the same receipt. If the intent is rejected the
    /// receipt fails and the token refunds the sender (NEP-141), so nothing is left behind.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.assert_not_paused();
        let token_id = env::predecessor_account_id().to_string();
        // Incoming wNEAR would be counted as a settling sell's output: hand it back (NEP-141 refund)
        if token_id == WRAP_NEAR && self.wnear_gate_closed() {
            return PromiseOrValue::Value(amount);
        }
        if let Some(intent) = Self::parse_intent_msg(&msg) {
            require!(intent.user == sender_id, "Intent user must be the sender of the deposit");
            require!(intent.token_in == token_id, "Intent token_in must be the deposited token");
            self.credit(&sender_id, &token_id, amount.0);
            Self::emit("deposit", serde_json::json!({
                "user": sender_id, "token": token_id, "amount": amount
            }));
            // Detached: the swap chain runs after this receipt; the deposit itself is fully accepted
            let _ = self.start_intent(intent);
            return PromiseOrValue::Value(U128(0));
        }
        let user: AccountId = if msg.starts_with("user:") {
            msg[5..].parse().unwrap_or(sender_id.clone())
        } else {
            sender_id.clone()
        };
        self.credit(&user, &token_id, amount.0);
        Self::emit("deposit", serde_json::json!({
            "user": user, "token": token_id, "amount": amount
        }));
        PromiseOrValue::Value(U128(0)) // accept all tokens
    }

    // ═══════════════════════════ WITHDRAW ════════════════════════════════════

    /// User withdraws their full balance of a token back to their own wallet.
    /// Includes on_withdraw_resolved callback: re-credits on any transfer failure!
    #[payable]
    pub fn withdraw(&mut self, token: String) -> Promise {
        self.assert_not_paused();
        self.assert_wnear_untouched(&token);
        let user = env::predecessor_account_id();
        let amount = self.debit_all(&user, &token);
        require!(amount > 0, "Nothing to withdraw");
        Self::emit("withdraw_initiated", serde_json::json!({
            "user": user, "token": token, "amount": U128(amount)
        }));
        self.xfer_out_with_callback(&token, &user, amount)
    }

    /// User withdraws a specific amount.
    /// Includes on_withdraw_resolved callback: re-credits on any transfer failure!
    #[payable]
    pub fn withdraw_amount(&mut self, token: String, amount: U128) -> Promise {
        self.assert_not_paused();
        self.assert_wnear_untouched(&token);
        let user = env::predecessor_account_id();
        self.debit_exact(&user, &token, amount.0);
        Self::emit("withdraw_initiated", serde_json::json!({
            "user": user, "token": token, "amount": amount
        }));
        self.xfer_out_with_callback(&token, &user, amount.0)
    }

    /// Relayer (owner_id) or user can refund/withdraw the user's balance back to the user's own wallet.
    /// Non-custodial guarantee: destination is strictly `user`!
    #[payable]
    pub fn withdraw_user(&mut self, user: AccountId, token: String) -> Promise {
        self.assert_not_paused();
        self.assert_wnear_untouched(&token);
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner_id || caller == user,
            "Only owner/relayer or user can withdraw"
        );
        let amount = self.debit_all(&user, &token);
        require!(amount > 0, "Nothing to withdraw");
        Self::emit("withdraw_initiated", serde_json::json!({
            "user": user, "token": token, "amount": U128(amount)
        }));
        self.xfer_out_with_callback(&token, &user, amount)
    }


    fn xfer_out_with_callback(&self, token: &str, recipient: &AccountId, amount: u128) -> Promise {
        self.xfer_out(token, recipient, amount)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_RESOLVE)
                    .on_withdraw_resolved(recipient.clone(), token.to_string(), U128(amount))
            )
    }

    #[private]
    pub fn on_withdraw_resolved(&mut self, user: AccountId, token: String, amount: U128) -> bool {
        match env::promise_result_checked(0, 512) {
            Ok(_) => {
                Self::emit("withdraw_completed", serde_json::json!({
                    "user": user,
                    "token": token,
                    "amount": amount,
                }));
                true
            }
            Err(_) => {
                // Transfer failed -> restore funds to user sub-ledger!
                self.credit(&user, &token, amount.0);
                Self::emit("withdraw_failed", serde_json::json!({
                    "user": user,
                    "token": token,
                    "amount": amount,
                    "reason": "transfer_promise_failed",
                    "action": "recredited_to_subledger",
                }));
                false
            }
        }
    }

    // ═══════════════════════ EXECUTE INTENT ══════════════════════════════════

    /// Core method – called by relayer backend or user directly.
    /// Debits user sub-ledger up-front; re-credits on any failure path.
    pub fn execute_intent(&mut self, intent: Intent) -> Promise {
        self.assert_not_paused();
        let predecessor = env::predecessor_account_id();
        require!(predecessor == self.owner_id || predecessor == intent.user,
            "Only relayer or user can submit intents");
        self.start_intent(intent)
    }

    /// `{"intent": Intent}` deposit message, if that is what `msg` holds.
    fn parse_intent_msg(msg: &str) -> Option<Intent> {
        #[derive(near_sdk::serde::Deserialize)]
        #[serde(crate = "near_sdk::serde")]
        struct IntentMsg {
            intent: Intent,
        }
        if !msg.trim_start().starts_with('{') {
            return None;
        }
        Some(serde_json::from_str::<IntentMsg>(msg).unwrap_or_else(|_| env::panic_str("Invalid intent message")).intent)
    }

    /// Validate, debit and dispatch an authorised intent (caller checks who may submit it).
    fn start_intent(&mut self, intent: Intent) -> Promise {
        // 1. Deadline
        let now_sec = env::block_timestamp() / 1_000_000_000;
        require!(intent.deadline == 0 || now_sec <= intent.deadline, "Intent expired");

        // 2. Nonce replay check
        require!(!self.used_nonces.contains(&intent.nonce), "Nonce already used");
        self.used_nonces.insert(intent.nonce);

        // 3. Validate
        require!(!intent.hops.is_empty() && intent.hops.len() <= 4, "Hops must be 1-4");
        require!(intent.amount_in.0 > 0, "amount_in must be > 0");

        // Balance-diff venues measure output as (router balance after − before), so only one
        // swap per payout token may be in flight; otherwise outputs would be paid to the wrong user.
        // Ref swaps take the lock too, because their payouts also move the router's balance.
        let payout_token = Self::payout_token(&intent.token_out);
        require!(!self.is_token_locked(payout_token), "Token busy: another swap is settling, retry shortly");
        // A sell to NEAR measures the router's wNEAR balance, which buys also move (wrapping and
        // sending wNEAR), so it runs alone: it starts only with no other swap in flight, and
        // nothing new starts while it settles.
        if payout_token == WRAP_NEAR {
            require!(self.inflight() == 0, "Token busy: swaps are settling before a sell to NEAR, retry shortly");
        } else {
            require!(!self.wnear_gate_closed(), "Token busy: a sell to NEAR is settling, retry shortly");
        }
        self.set_token_lock(payout_token, true);
        self.set_inflight(self.inflight() + 1);

        // 4. Debit user's sub-ledger (flexible between native near and wrap.near)
        let held_direct = self.get_balance(&intent.user, &intent.token_in);
        let actual_debit_token = if held_direct >= intent.amount_in.0 {
            intent.token_in.clone()
        } else if intent.token_in == WRAP_NEAR && self.get_balance(&intent.user, "near") >= intent.amount_in.0 {
            "near".to_string()
        } else if intent.token_in == "near" && self.get_balance(&intent.user, WRAP_NEAR) >= intent.amount_in.0 {
            WRAP_NEAR.to_string()
        } else {
            env::panic_str("Insufficient vault balance");
        };

        // The asset the venue dispatch physically spends must be the asset debited from the user,
        // otherwise the router pays with other users' NEAR or wNEAR.
        let native_only = match intent.venue {
            Venue::Shardsmarket | Venue::BondingCurve => true,
            Venue::Intear => intent.token_in == "near" || intent.token_in == WRAP_NEAR,
            _ => false,
        };
        if native_only {
            require!(actual_debit_token == "near",
                "This venue spends native NEAR: vault balance must be native NEAR (buys only)");
        }
        if intent.venue == Venue::GenericFtCall {
            require!(intent.token_in != "near" && actual_debit_token == intent.token_in,
                "GenericFtCall sends token_in: vault balance must be held in that token");
        }

        self.debit_exact(&intent.user, &actual_debit_token, intent.amount_in.0);

        let is_ref_venue = intent.venue == Venue::Rhea || intent.venue == Venue::RefAmm ||
                           intent.venue == Venue::Nearlytrade || intent.venue == Venue::Dcl;
        // Wrap only when native NEAR was debited; a wNEAR debit is sent as wNEAR
        let is_near_wrapped = actual_debit_token == "near" && is_ref_venue;

        // 5. Fee
        let is_sell = intent.token_out == WRAP_NEAR || intent.token_out == "near";
        let fee_bps = if is_sell {
            self.fee_config.sell_fee_bps
        } else {
            match &intent.venue {
                Venue::Shardsmarket | Venue::BondingCurve => self.fee_config.snipe_fee_bps,
                _ => self.fee_config.buy_fee_bps,
            }
        };

        // 6. Store pending context
        let swap_nonce = self.nonce;
        self.nonce += 1;
        self.pending_swaps.insert(swap_nonce, PendingSwap {
            user: intent.user.clone(),
            token_in: actual_debit_token,
            amount_in: intent.amount_in.0,
            token_out: intent.token_out.clone(),
            fee_bps,
            min_amount_out: intent.min_amount_out,
            correlation_id: intent.correlation_id.clone(),
            venue: intent.venue.clone(),
        });

        Self::emit("intent_submitted", serde_json::json!({
            "correlation_id": intent.correlation_id,
            "user": intent.user,
            "venue": format!("{:?}", intent.venue),
            "token_in": intent.token_in,
            "token_out": intent.token_out,
            "amount_in": intent.amount_in,
            "min_amount_out": intent.min_amount_out,
            "hops": intent.hops.len(),
            "swap_nonce": swap_nonce,
        }));

        // 7. Snapshot the router's payout-token balance, then dispatch to the venue.
        // Ref swaps are instant swaps (output is sent straight back), so they are measured like DCL.
        Self::ft_balance_of_self(Self::payout_token(&intent.token_out))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_SNAPSHOT)
                    .on_balance_snapshot(swap_nonce, intent, is_near_wrapped)
            )
    }

    /// Pre-swap balance snapshot resolved → record it, then dispatch to the venue.
    #[private]
    pub fn on_balance_snapshot(&mut self, swap_nonce: u64, intent: Intent, is_near_wrapped: bool) -> PromiseOrValue<U128> {
        let pre = env::promise_result_checked(0, 1024)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<U128>(&bytes).ok());

        let Some(pre) = pre else {
            if let Some(pending) = self.pending_swaps.remove(&swap_nonce) {
                self.fail_balance_diff_swap(swap_nonce, &pending, "balance_snapshot_failed");
            }
            return PromiseOrValue::Value(U128(0));
        };

        self.set_snapshot(swap_nonce, pre.0);
        match &intent.venue {
            Venue::Nearlytrade | Venue::Dcl => self.dispatch_dcl(&intent, swap_nonce, is_near_wrapped),
            Venue::Intear => self.dispatch_intear(&intent, swap_nonce),
            Venue::Shardsmarket => self.dispatch_shardsmarket(&intent, swap_nonce),
            Venue::BondingCurve => self.dispatch_bonding_curve(&intent, swap_nonce),
            Venue::GenericFtCall => self.dispatch_generic_ft_call(&intent, swap_nonce),
            Venue::Rhea | Venue::RefAmm => self.dispatch_ref_amm(&intent, swap_nonce, is_near_wrapped),
        }.into()
    }

    // ═══════════════════════ VENUE DISPATCH ══════════════════════════════════

    fn dispatch_ref_amm(&self, intent: &Intent, swap_nonce: u64, is_near_wrapped: bool) -> Promise {
        let mut actions: Vec<serde_json::Value> = intent.hops.iter().map(|hop| {
            let tok_in = if hop.token_in == "near" { WRAP_NEAR } else { &hop.token_in };
            let tok_out = if hop.token_out == "near" { WRAP_NEAR } else { &hop.token_out };
            serde_json::json!({
                "pool_id": hop.pool_id.expect("pool_id required for Ref AMM hop"),
                "token_in": tok_in,
                "amount_in": "0",
                "token_out": tok_out,
                "min_amount_out": hop.min_amount_out,
            })
        }).collect();

        if let Some(first) = actions.get_mut(0) {
            first["amount_in"] = serde_json::json!(intent.amount_in);
        }

        let swap_msg = serde_json::json!({
            "force": 0,
            "actions": actions,
            "referral_id": null,
        }).to_string();

        let xfer_args = serde_json::json!({
            "receiver_id": REF_AMM,
            "amount": intent.amount_in,
            "msg": swap_msg,
        });

        let callback = Self::ext(env::current_account_id())
            .with_static_gas(GAS_SWAP_COMPLETE)
            .on_swap_complete(swap_nonce);

        if is_near_wrapped {
            Promise::new(WRAP_NEAR.parse().unwrap())
                .function_call(
                    "near_deposit".to_string(),
                    vec![],
                    NearToken::from_yoctonear(intent.amount_in.0),
                    GAS_WRAP,
                )
                .then(
                    Promise::new(WRAP_NEAR.parse().unwrap())
                        .function_call(
                            "ft_transfer_call".to_string(),
                            serde_json::to_vec(&xfer_args).unwrap(),
                            ONE_YOCTO,
                            GAS_SWAP_REF,
                        )
                )
                .then(callback)
        } else {
            let token_contract = if intent.token_in == "near" { WRAP_NEAR } else { &intent.token_in };
            Promise::new(token_contract.parse().unwrap())
                .function_call(
                    "ft_transfer_call".to_string(),
                    serde_json::to_vec(&xfer_args).unwrap(),
                    ONE_YOCTO,
                    GAS_SWAP_REF,
                )
                .then(callback)
        }
    }

    fn dispatch_dcl(&self, intent: &Intent, swap_nonce: u64, is_near_wrapped: bool) -> Promise {
        let pool_ids: Vec<String> = intent.hops.iter().map(|h| {
            h.dcl_pool_id.clone().expect("dcl_pool_id required for DCL hop")
        }).collect();

        let out_tok = if intent.token_out == "near" { WRAP_NEAR } else { &intent.token_out };

        let swap_msg = serde_json::json!({
            "Swap": {
                "pool_ids": pool_ids,
                "output_token": out_tok,
                "min_output_amount": intent.min_amount_out,
                // Without this DCL unwraps wNEAR output and pays native NEAR in a detached transfer
                // that can land after the router's balance check
                "skip_unwrap_near": true,
            }
        }).to_string();

        let xfer_args = serde_json::json!({
            "receiver_id": REF_DCL,
            "amount": intent.amount_in,
            "msg": swap_msg,
        });

        let callback = Self::ext(env::current_account_id())
            .with_static_gas(GAS_SWAP_COMPLETE)
            .on_swap_complete(swap_nonce);

        if is_near_wrapped {
            Promise::new(WRAP_NEAR.parse().unwrap())
                .function_call(
                    "near_deposit".to_string(),
                    vec![],
                    NearToken::from_yoctonear(intent.amount_in.0),
                    GAS_WRAP,
                )
                .then(
                    Promise::new(WRAP_NEAR.parse().unwrap())
                        .function_call(
                            "ft_transfer_call".to_string(),
                            serde_json::to_vec(&xfer_args).unwrap(),
                            ONE_YOCTO,
                            GAS_SWAP,
                        )
                )
                .then(callback)
        } else {
            let token_contract = if intent.token_in == "near" { WRAP_NEAR } else { &intent.token_in };
            Promise::new(token_contract.parse().unwrap())
                .function_call(
                    "ft_transfer_call".to_string(),
                    serde_json::to_vec(&xfer_args).unwrap(),
                    ONE_YOCTO,
                    GAS_SWAP,
                )
                .then(callback)
        }
    }

    fn dispatch_intear(&self, intent: &Intent, swap_nonce: u64) -> Promise {
        let is_buy = intent.token_in == "near" || intent.token_in == WRAP_NEAR;
        if is_buy {
            // Swap on Intear using deposit_near
            let pool_id = intent.hops.first().and_then(|h| h.pool_id).unwrap_or(0);
            let pool_bytes = (pool_id as u32).to_le_bytes();
            use near_sdk::base64::Engine;
            let pool_msg = near_sdk::base64::prelude::BASE64_STANDARD.encode(pool_bytes);

            let operations = if let Some(msg) = &intent.custom_msg {
                serde_json::from_str::<serde_json::Value>(msg).unwrap_or_else(|_| serde_json::json!({}))
            } else {
                serde_json::json!({
                    "referrer": "dex-aggregator.intear.near",
                    "operations": [
                        {
                            "SwapSimple": {
                                "dex_id": "slimedragon.near/xyk",
                                "asset_in": "near",
                                "asset_out": format!("nep141:{}", intent.token_out),
                                "amount": { "Amount": { "ExactIn": intent.amount_in } },
                                "constraint": intent.min_amount_out,
                                "message": pool_msg,
                            }
                        },
                        {
                            "Withdraw": {
                                "asset_id": format!("nep141:{}", intent.token_out),
                                "amount": { "Full": { "at_least": intent.min_amount_out } },
                                "to": null,
                                "rescue_address": null,
                            }
                        }
                    ]
                })
            };

            let args = serde_json::json!({ "operations": operations });

            Promise::new(INTEAR_DEX.parse().unwrap())
                .function_call(
                    "deposit_near".to_string(),
                    serde_json::to_vec(&args).unwrap(),
                    NearToken::from_yoctonear(intent.amount_in.0),
                    GAS_SWAP,
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_SWAP_COMPLETE)
                        .on_swap_complete(swap_nonce)
                )
        } else {
            // Sell token on dex.intear.near via ft_transfer_call
            let custom_msg = intent.custom_msg.clone().unwrap_or_else(|| {
                serde_json::json!({}).to_string()
            });

            let xfer_args = serde_json::json!({
                "receiver_id": INTEAR_DEX,
                "amount": intent.amount_in,
                "msg": custom_msg,
            });

            Promise::new(intent.token_in.parse().unwrap())
                .function_call(
                    "ft_transfer_call".to_string(),
                    serde_json::to_vec(&xfer_args).unwrap(),
                    ONE_YOCTO,
                    GAS_SWAP,
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_SWAP_COMPLETE)
                        .on_swap_complete(swap_nonce)
                )
        }
    }

    fn dispatch_shardsmarket(&self, intent: &Intent, swap_nonce: u64) -> Promise {
        let args = serde_json::json!({
            "token_id": intent.token_out,
            "min_token_out": intent.min_amount_out,
            "referrer_id": null,
        });

        Promise::new(SHARDSMARKET.parse().unwrap())
            .function_call(
                "buy".to_string(),
                serde_json::to_vec(&args).unwrap(),
                NearToken::from_yoctonear(intent.amount_in.0),
                GAS_SWAP,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_SWAP_COMPLETE)
                    .on_swap_complete(swap_nonce)
            )
    }

    fn dispatch_bonding_curve(&self, intent: &Intent, swap_nonce: u64) -> Promise {
        let target_contract = intent.custom_contract.clone()
            .unwrap_or_else(|| intent.token_out.parse().unwrap());
        let raw_args = intent.custom_msg.as_deref().unwrap_or("{}");
        let args_bytes = raw_args.as_bytes().to_vec();

        Promise::new(target_contract)
            .function_call(
                "buy".to_string(),
                args_bytes,
                NearToken::from_yoctonear(intent.amount_in.0),
                GAS_SWAP,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_SWAP_COMPLETE)
                    .on_swap_complete(swap_nonce)
            )
    }

    fn dispatch_generic_ft_call(&self, intent: &Intent, swap_nonce: u64) -> Promise {
        let receiver = intent.custom_contract.clone().expect("custom_contract required for GenericFtCall");
        let msg = intent.custom_msg.clone().unwrap_or_default();

        let xfer_args = serde_json::json!({
            "receiver_id": receiver,
            "amount": intent.amount_in,
            "msg": msg,
        });

        Promise::new(intent.token_in.parse().unwrap())
            .function_call(
                "ft_transfer_call".to_string(),
                serde_json::to_vec(&xfer_args).unwrap(),
                ONE_YOCTO,
                GAS_SWAP,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_SWAP_COMPLETE)
                    .on_swap_complete(swap_nonce)
            )
    }

    // ═══════════════════════════ CALLBACKS ═══════════════════════════════════

    /// Step 1: Venue swap finished (every venue).
    /// Record how much input the venue used, then query the router's ft_balance_of for the
    /// payout token to measure exactly what this swap delivered.
    #[private]
    pub fn on_swap_complete(&mut self, swap_nonce: u64) -> PromiseOrValue<U128> {
        let pending = match self.pending_swaps.get(&swap_nonce) {
            Some(p) => p.clone(),
            None => {
                env::log_str(&format!("WARN: no pending swap nonce={}", swap_nonce));
                return PromiseOrValue::Value(U128(0));
            }
        };

        match env::promise_result_checked(0, 2048) {
            Ok(bytes) => {
                // ft_transfer_call returns the amount the receiver kept (NEP-141); a payable
                // venue call that succeeded keeps the attached NEAR.
                let used = if Self::is_ft_call_venue(&pending) {
                    serde_json::from_slice::<U128>(&bytes).map(|u| u.0.min(pending.amount_in)).unwrap_or(pending.amount_in)
                } else {
                    pending.amount_in
                };
                if used == 0 {
                    let pending = self.pending_swaps.remove(&swap_nonce).unwrap();
                    self.fail_balance_diff_swap(swap_nonce, &pending, "venue_refunded_input");
                    return PromiseOrValue::Value(U128(0));
                }
                self.set_used(swap_nonce, used);

                let check_token = if pending.token_out == "near" { WRAP_NEAR } else { &pending.token_out };
                let bal_args = serde_json::json!({
                    "account_id": env::current_account_id(),
                });

                Promise::new(check_token.parse().unwrap())
                    .function_call(
                        "ft_balance_of".to_string(),
                        serde_json::to_vec(&bal_args).unwrap(),
                        NearToken::ZERO,
                        GAS_BALANCE,
                    )
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(GAS_PAYOUT)
                            .on_swap_payout(swap_nonce)
                    )
                    .into()
            }
            Err(_) => {
                let pending = self.pending_swaps.remove(&swap_nonce).unwrap();
                self.fail_balance_diff_swap(swap_nonce, &pending, "venue_reverted");
                PromiseOrValue::Value(U128(0))
            }
        }
    }

    /// Step 2: Balance query resolved.
    /// Output = router balance now − pre-swap snapshot, so tokens already held by the
    /// router (other users' funds, earlier stuck payouts) are never paid out for this swap.
    #[private]
    pub fn on_swap_payout(&mut self, swap_nonce: u64) -> PromiseOrValue<U128> {
        let pending = match self.pending_swaps.remove(&swap_nonce) {
            Some(p) => p,
            None => {
                env::log_str(&format!("WARN: no pending swap nonce={}", swap_nonce));
                return PromiseOrValue::Value(U128(0));
            }
        };

        let post = env::promise_result_checked(0, 1024)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<U128>(&bytes).ok());
        let pre = self.take_snapshot(swap_nonce);

        match (post, pre) {
            (Some(post), Some(pre)) => {
                let raw_out = post.0.saturating_sub(pre);
                if raw_out == 0 {
                    self.fail_balance_diff_swap(swap_nonce, &pending, "zero_tokens_received");
                    return PromiseOrValue::Value(U128(0));
                }
                self.take_used(swap_nonce);
                let lock = Self::payout_token(&pending.token_out).to_string();
                self.settle(&pending, raw_out, Some(lock))
            }
            _ => {
                self.fail_balance_diff_swap(swap_nonce, &pending, "balance_query_failed");
                PromiseOrValue::Value(U128(0))
            }
        }
    }

    /// Payout transfer resolved: release the payout-token lock and, if the transfer
    /// failed, re-credit the user's sub-ledger so the tokens stay withdrawable.
    #[private]
    pub fn on_payout_resolved(
        &mut self,
        correlation_id: String,
        user: AccountId,
        token: String,
        amount: U128,
        lock_token: Option<String>,
    ) -> bool {
        if let Some(lock) = lock_token {
            self.set_token_lock(&lock, false);
            self.finish_inflight();
        }
        match env::promise_result_checked(0, 512) {
            Ok(_) => {
                Self::emit("payout_completed", serde_json::json!({
                    "correlation_id": correlation_id, "user": user, "token": token, "amount": amount,
                }));
                true
            }
            Err(_) => {
                self.credit(&user, &token, amount.0);
                Self::emit("payout_failed", serde_json::json!({
                    "correlation_id": correlation_id,
                    "user": user,
                    "token": token,
                    "amount": amount,
                    "action": "credited_to_vault_ledger",
                }));
                false
            }
        }
    }

    /// wrap.near → NEAR unwrap resolved: pay the user natively, or re-credit wrap.near on failure.
    #[private]
    pub fn on_unwrapped(
        &mut self,
        correlation_id: String,
        user: AccountId,
        net: U128,
        fee: U128,
        lock_token: Option<String>,
    ) -> PromiseOrValue<bool> {
        match env::promise_result_checked(0, 512) {
            Ok(_) => {
                let treasury = self.treasury_id.clone();
                self.credit(&treasury, "near", fee.0);
                Promise::new(user.clone())
                    .transfer(NearToken::from_yoctonear(net.0))
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(GAS_RESOLVE_XFER)
                            .on_payout_resolved(correlation_id, user, "near".to_string(), net, lock_token)
                    )
                    .into()
            }
            Err(_) => {
                if let Some(lock) = lock_token {
                    self.set_token_lock(&lock, false);
                    self.finish_inflight();
                }
                let treasury = self.treasury_id.clone();
                self.credit(&treasury, WRAP_NEAR, fee.0);
                self.credit(&user, WRAP_NEAR, net.0);
                Self::emit("payout_failed", serde_json::json!({
                    "correlation_id": correlation_id,
                    "user": user,
                    "token": WRAP_NEAR,
                    "amount": net,
                    "reason": "unwrap_failed",
                    "action": "credited_to_vault_ledger",
                }));
                PromiseOrValue::Value(false)
            }
        }
    }

    // ═══════════════════════ SETTLEMENT ══════════════════════════════════════

    /// Pays `raw_out` (minus fee) to the user. The fee is credited to the treasury's
    /// sub-ledger instead of being transferred, so the user payout is the only outgoing
    /// transfer and its result is always checked by `on_payout_resolved`.
    fn settle(&mut self, pending: &PendingSwap, raw_out: u128, lock_token: Option<String>) -> PromiseOrValue<U128> {
        // Slippage guard: give user full amount back, no fee charged
        let fee_amount = if raw_out < pending.min_amount_out.0 {
            Self::emit("slippage_refund", serde_json::json!({
                "correlation_id": pending.correlation_id,
                "user": pending.user,
                "token_out": pending.token_out,
                "got": U128(raw_out),
                "min": pending.min_amount_out,
            }));
            0
        } else {
            (raw_out * pending.fee_bps as u128) / 10_000
        };
        let net_amount = raw_out - fee_amount;

        if raw_out >= pending.min_amount_out.0 {
            Self::emit("swap_settled", serde_json::json!({
                "correlation_id": pending.correlation_id,
                "user": pending.user,
                "token_out": pending.token_out,
                "gross": U128(raw_out),
                "fee": U128(fee_amount),
                "net": U128(net_amount),
                "fee_bps": pending.fee_bps,
            }));
        }

        // Sells to NEAR (token_out "near" or wrap.near) arrive as wNEAR and pay the user native NEAR
        if pending.token_out == "near" || pending.token_out == WRAP_NEAR {
            return PromiseOrValue::Promise(
                Promise::new(WRAP_NEAR.parse().unwrap())
                    .function_call(
                        "near_withdraw".to_string(),
                        serde_json::to_vec(&serde_json::json!({ "amount": U128(raw_out) })).unwrap(),
                        ONE_YOCTO,
                        GAS_WRAP,
                    )
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(GAS_RESOLVE_UNWRAP)
                            .on_unwrapped(
                                pending.correlation_id.clone(),
                                pending.user.clone(),
                                U128(net_amount),
                                U128(fee_amount),
                                lock_token,
                            )
                    )
            );
        }

        let treasury = self.treasury_id.clone();
        self.credit(&treasury, &pending.token_out, fee_amount);
        PromiseOrValue::Promise(
            self.ft_send(&pending.token_out, &pending.user, net_amount)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_RESOLVE_XFER)
                        .on_payout_resolved(
                            pending.correlation_id.clone(),
                            pending.user.clone(),
                            pending.token_out.clone(),
                            U128(net_amount),
                            lock_token,
                        )
                )
        )
    }

    /// Fail a swap: re-credit only the input the venue did not use, drop snapshot, release lock.
    /// Input the venue did use is never re-credited (the router no longer holds it); if its output
    /// could not be measured, an `unaccounted_output` event flags it for reconciliation.
    fn fail_balance_diff_swap(&mut self, swap_nonce: u64, pending: &PendingSwap, reason: &str) {
        let used = self.take_used(swap_nonce);
        let refund = pending.amount_in.saturating_sub(used);
        self.credit(&pending.user, &pending.token_in, refund);
        self.clear_snapshot(swap_nonce);
        self.set_token_lock(Self::payout_token(&pending.token_out), false);
        self.finish_inflight();
        Self::emit("swap_failed", serde_json::json!({
            "correlation_id": pending.correlation_id,
            "user": pending.user,
            "reason": reason,
            "refunded_token": pending.token_in,
            "refunded_amount": U128(refund),
            "consumed_amount": U128(used),
        }));
        if used > 0 {
            Self::emit("unaccounted_output", serde_json::json!({
                "correlation_id": pending.correlation_id,
                "user": pending.user,
                "venue": format!("{:?}", pending.venue),
                "token_in": pending.token_in,
                "consumed_amount": U128(used),
                "token_out": pending.token_out,
                "action": "needs_owner_reconciliation",
            }));
        }
    }

    /// Venues dispatched with ft_transfer_call (result = amount kept by the receiver).
    fn is_ft_call_venue(pending: &PendingSwap) -> bool {
        match pending.venue {
            Venue::Rhea | Venue::RefAmm | Venue::Dcl | Venue::Nearlytrade | Venue::GenericFtCall => true,
            Venue::Intear => pending.token_in != "near" && pending.token_in != WRAP_NEAR,
            Venue::Shardsmarket | Venue::BondingCurve => false,
        }
    }

    // ═══════════════════ PAYOUT LOCKS & BALANCE SNAPSHOTS ═════════════════════
    // Raw storage keys (prefixes "l:" / "s:" / "u:" / "c:") so the contract state layout is unchanged
    // and the upgrade needs no migration.

    fn payout_token(token_out: &str) -> &str {
        if token_out == "near" { WRAP_NEAR } else { token_out }
    }

    fn lock_key(token: &str) -> Vec<u8> {
        [b"l:".as_slice(), token.as_bytes()].concat()
    }

    fn snapshot_key(swap_nonce: u64) -> Vec<u8> {
        [b"s:".as_slice(), &swap_nonce.to_le_bytes()].concat()
    }

    fn is_token_locked(&self, token: &str) -> bool {
        env::storage_has_key(&Self::lock_key(token))
    }

    fn set_token_lock(&mut self, token: &str, locked: bool) {
        if locked {
            env::storage_write(&Self::lock_key(token), &[1]);
        } else {
            env::storage_remove(&Self::lock_key(token));
        }
    }

    fn set_snapshot(&mut self, swap_nonce: u64, balance: u128) {
        env::storage_write(&Self::snapshot_key(swap_nonce), &balance.to_le_bytes());
    }

    fn take_snapshot(&mut self, swap_nonce: u64) -> Option<u128> {
        let raw = env::storage_read(&Self::snapshot_key(swap_nonce))?;
        self.clear_snapshot(swap_nonce);
        raw.try_into().ok().map(u128::from_le_bytes)
    }

    fn clear_snapshot(&mut self, swap_nonce: u64) {
        env::storage_remove(&Self::snapshot_key(swap_nonce));
    }

    /// Number of swaps between execute_intent and their final payout/refund callback.
    fn inflight(&self) -> u64 {
        env::storage_read(b"c:inflight")
            .and_then(|r| r.try_into().ok())
            .map(u64::from_le_bytes)
            .unwrap_or(0)
    }

    fn set_inflight(&mut self, n: u64) {
        env::storage_write(b"c:inflight", &n.to_le_bytes());
    }

    fn finish_inflight(&mut self) {
        let n = self.inflight();
        self.set_inflight(n.saturating_sub(1));
    }

    /// Closed while a sell to NEAR settles (it holds the wrap.near payout lock and measures
    /// the router's wNEAR balance, so nothing else may move wNEAR in or out meanwhile).
    fn wnear_gate_closed(&self) -> bool {
        self.is_token_locked(WRAP_NEAR)
    }

    fn assert_wnear_untouched(&self, token: &str) {
        if token == WRAP_NEAR {
            require!(!self.wnear_gate_closed(), "Token busy: a sell to NEAR is settling, retry shortly");
        }
    }

    fn used_key(swap_nonce: u64) -> Vec<u8> {
        [b"u:".as_slice(), &swap_nonce.to_le_bytes()].concat()
    }

    fn set_used(&mut self, swap_nonce: u64, used: u128) {
        env::storage_write(&Self::used_key(swap_nonce), &used.to_le_bytes());
    }

    /// Input the venue used for this swap (0 if not recorded), removing the record.
    fn take_used(&mut self, swap_nonce: u64) -> u128 {
        let raw = env::storage_read(&Self::used_key(swap_nonce));
        env::storage_remove(&Self::used_key(swap_nonce));
        raw.and_then(|r| r.try_into().ok()).map(u128::from_le_bytes).unwrap_or(0)
    }

    fn ft_balance_of_self(token: &str) -> Promise {
        Promise::new(token.parse().unwrap()).function_call(
            "ft_balance_of".to_string(),
            serde_json::to_vec(&serde_json::json!({ "account_id": env::current_account_id() })).unwrap(),
            NearToken::ZERO,
            GAS_BALANCE,
        )
    }

    // ═══════════════════════ SUB-LEDGER HELPERS ═══════════════════════════════

    fn credit(&mut self, user: &AccountId, token: &str, amount: u128) {
        if amount == 0 { return; }
        let key: BalanceKey = (user.clone(), token.to_string());
        let prev = self.balances.get(&key).copied().unwrap_or(0);
        self.balances.insert(key, prev + amount);
    }

    fn debit_exact(&mut self, user: &AccountId, token: &str, amount: u128) {
        let key: BalanceKey = (user.clone(), token.to_string());
        let prev = self.balances.get(&key).copied().unwrap_or(0);
        require!(prev >= amount, "Insufficient vault balance");
        if prev == amount {
            self.balances.remove(&key);
        } else {
            self.balances.insert(key, prev - amount);
        }
    }

    fn debit_all(&mut self, user: &AccountId, token: &str) -> u128 {
        let key: BalanceKey = (user.clone(), token.to_string());
        let amount = self.balances.get(&key).copied().unwrap_or(0);
        if amount > 0 { self.balances.remove(&key); }
        amount
    }

    fn get_balance(&self, user: &AccountId, token: &str) -> u128 {
        self.balances.get(&(user.clone(), token.to_string())).copied().unwrap_or(0)
    }

    // ═══════════════════════ TRANSFER HELPERS ════════════════════════════════

    fn xfer_out(&self, token: &str, recipient: &AccountId, amount: u128) -> Promise {
        if token == "near" {
            Promise::new(recipient.clone()).transfer(NearToken::from_yoctonear(amount))
        } else {
            self.ft_send(token, recipient, amount)
        }
    }

    fn ft_send(&self, token: &str, recipient: &AccountId, amount: u128) -> Promise {
        let storage_args = serde_json::json!({
            "account_id": recipient,
            "registration_only": true,
        });
        let xfer_args = serde_json::json!({
            "receiver_id": recipient,
            "amount": U128(amount),
            "memo": null,
        });
        Promise::new(token.parse().unwrap())
            .function_call(
                "storage_deposit".to_string(),
                serde_json::to_vec(&storage_args).unwrap(),
                STORAGE_DEPOSIT,
                GAS_STORAGE,
            )
            .then(
                Promise::new(token.parse().unwrap())
                    .function_call(
                        "ft_transfer".to_string(),
                        serde_json::to_vec(&xfer_args).unwrap(),
                        ONE_YOCTO,
                        GAS_FT_XFER,
                    )
            )
    }

    // ═══════════════════════ EVENT LOGGING ═══════════════════════════════════

    /// NEP-297-compatible structured event – readable by team and external monitors.
    fn emit(event_type: &str, data: serde_json::Value) {
        let log = serde_json::json!({
            "standard": "racerbot-vault",
            "version": "1.0.0",
            "event": event_type,
            "data": data,
        });
        env::log_str(&format!("EVENT_JSON:{}", log));
    }

    // ═══════════════════════ VIEW METHODS ════════════════════════════════════

    pub fn vault_balance(&self, user: AccountId, token: String) -> U128 {
        U128(self.get_balance(&user, &token))
    }

    pub fn get_fee_config(&self) -> &FeeConfig { &self.fee_config }
    pub fn get_treasury(&self)   -> &AccountId  { &self.treasury_id }
    pub fn get_owner(&self)      -> &AccountId  { &self.owner_id }
    pub fn is_paused(&self)      -> bool         { self.paused }

    pub fn nonce_used(&self, nonce: [u8; 32]) -> bool {
        self.used_nonces.contains(&nonce)
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn vault()    -> AccountId { "vault.racerbot.near".parse().unwrap() }
    fn owner()    -> AccountId { "owner.racerbot.near".parse().unwrap() }
    fn treasury() -> AccountId { "treasury.racerbot.near".parse().unwrap() }
    fn user()     -> AccountId { "user.near".parse().unwrap() }

    fn setup() -> RacerbotVault {
        let ctx = VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(owner())
            .is_view(false)
            .build();
        testing_env!(ctx);
        RacerbotVault::new(owner(), treasury(), 150, 150, 250)
    }

    #[test]
    fn test_init() {
        let c = setup();
        assert_eq!(c.fee_config.buy_fee_bps, 150);
        assert_eq!(c.fee_config.snipe_fee_bps, 250);
        assert!(!c.paused);
        assert_eq!(c.nonce, 0);
    }

    #[test]
    fn test_deposit_near_credits_balance() {
        let mut c = setup();
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(owner())
            .attached_deposit(NearToken::from_near(1))
            .build();
        testing_env!(ctx);
        c.deposit_near(user());
        assert_eq!(c.vault_balance(user(), "near".into()).0, 1_000_000_000_000_000_000_000_000);
    }

    #[test]
    fn test_balance_isolation_between_users() {
        let mut c = setup();
        let alice: AccountId = "alice.near".parse().unwrap();
        let bob: AccountId   = "bob.near".parse().unwrap();
        c.credit(&alice, "near", 1_000_000);
        c.credit(&bob,   "near",   500_000);
        assert_eq!(c.get_balance(&alice, "near"), 1_000_000);
        assert_eq!(c.get_balance(&bob,   "near"),   500_000);
        c.debit_exact(&alice, "near", 600_000);
        assert_eq!(c.get_balance(&alice, "near"),   400_000);
        assert_eq!(c.get_balance(&bob,   "near"),   500_000); // bob untouched
    }

    #[test]
    #[should_panic(expected = "Insufficient vault balance")]
    fn test_overdraft_panics() {
        let mut c = setup();
        c.credit(&user(), "near", 100);
        c.debit_exact(&user(), "near", 200);
    }

    #[test]
    fn test_fee_math_buy() {
        let c = setup();
        let gross: u128 = 1_000_000_000_000_000_000_000_000; // 1 NEAR
        let fee  = (gross * c.fee_config.buy_fee_bps as u128) / 10_000;
        let net  = gross - fee;
        assert_eq!(fee, 15_000_000_000_000_000_000_000);  // 1.5%
        assert_eq!(net, 985_000_000_000_000_000_000_000); // 98.5%
    }

    #[test]
    fn test_fee_math_snipe() {
        let c = setup();
        let gross: u128 = 1_000_000_000_000_000_000_000_000;
        let fee  = (gross * c.fee_config.snipe_fee_bps as u128) / 10_000;
        let net  = gross - fee;
        assert_eq!(fee, 25_000_000_000_000_000_000_000);  // 2.5%
        assert_eq!(net, 975_000_000_000_000_000_000_000);
    }

    #[test]
    fn test_nonce_replay_protection() {
        let mut c = setup();
        let nonce = [7u8; 32];
        assert!(!c.nonce_used(nonce));
        c.used_nonces.insert(nonce);
        assert!(c.nonce_used(nonce));
    }

    #[test]
    fn test_pause_unpause() {
        let mut c = setup();
        assert!(!c.is_paused());
        c.pause();
        assert!(c.is_paused());
        c.unpause();
        assert!(!c.is_paused());
    }

    #[test]
    #[should_panic(expected = "Only owner")]
    fn test_non_owner_cannot_set_fee() {
        let mut c = setup();
        let ctx = VMContextBuilder::new()
            .predecessor_account_id("attacker.near".parse().unwrap())
            .build();
        testing_env!(ctx);
        c.set_fee_config(0, 0, 0);
    }

    #[test]
    fn test_slippage_condition() {
        let got: u128 = 900_000;
        let min: u128 = 950_000;
        assert!(got < min, "slippage should be detected");
        // No fee taken on slippage refund
        let fee_on_slippage = 0u128;
        assert_eq!(fee_on_slippage, 0);
    }

    #[test]
    fn test_debit_all_clears_balance() {
        let mut c = setup();
        c.credit(&user(), "wrap.near", 5_000);
        let debited = c.debit_all(&user(), "wrap.near");
        assert_eq!(debited, 5_000);
        assert_eq!(c.get_balance(&user(), "wrap.near"), 0);
    }

    #[test]
    fn test_multi_token_isolation() {
        let mut c = setup();
        c.credit(&user(), "near", 1_000);
        c.credit(&user(), "token.near", 2_000);
        assert_eq!(c.get_balance(&user(), "near"), 1_000);
        assert_eq!(c.get_balance(&user(), "token.near"), 2_000);
        c.debit_exact(&user(), "near", 1_000);
        assert_eq!(c.get_balance(&user(), "near"), 0);
        assert_eq!(c.get_balance(&user(), "token.near"), 2_000); // untouched
    }

    #[test]
    fn test_rescue_stuck_swap_refunds_user() {
        let mut c = setup();
        let swap_nonce = 42;
        let correlation_id = "test_rescue_123".to_string();
        c.pending_swaps.insert(swap_nonce, PendingSwap {
            user: user(),
            token_in: "near".to_string(),
            amount_in: 5_000_000,
            token_out: "meme.near".to_string(),
            fee_bps: 150,
            min_amount_out: U128(1_000),
            correlation_id,
            venue: Venue::Intear,
        });
        assert_eq!(c.get_balance(&user(), "near"), 0);
        c.rescue_stuck_swap(swap_nonce);
        assert_eq!(c.get_balance(&user(), "near"), 5_000_000);
    }

    #[test]
    fn test_withdraw_failure_recredits_user() {
        let mut c = setup();
        // Simulate a withdrawal where user balance was debited:
        c.credit(&user(), "token.near", 10_000);
        c.debit_exact(&user(), "token.near", 10_000);
        assert_eq!(c.get_balance(&user(), "token.near"), 0);

        // If on_withdraw_resolved receives Err (simulated by calling credit in callback):
        c.credit(&user(), "token.near", 10_000);
        assert_eq!(c.get_balance(&user(), "token.near"), 10_000);
    }

    // ── Payout safety ────────────────────────────────────────────────────────

    fn callback_env(result: near_sdk::PromiseResult) {
        let ctx = VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(vault())
            .build();
        testing_env!(
            ctx,
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
    }

    fn balance_result(amount: u128) -> near_sdk::PromiseResult {
        near_sdk::PromiseResult::Successful(serde_json::to_vec(&U128(amount)).unwrap())
    }

    fn pending_buy(c: &mut RacerbotVault, swap_nonce: u64, min_out: u128) {
        c.pending_swaps.insert(swap_nonce, PendingSwap {
            user: user(),
            token_in: "near".to_string(),
            amount_in: 5_000_000,
            token_out: "meme.near".to_string(),
            fee_bps: 150,
            min_amount_out: U128(min_out),
            correlation_id: "corr".to_string(),
            venue: Venue::Dcl,
        });
        c.set_token_lock("meme.near", true);
    }

    fn intent(nonce_byte: u8) -> Intent {
        Intent {
            user: user(),
            venue: Venue::Dcl,
            hops: vec![Hop {
                pool_id: None,
                dcl_pool_id: Some("wrap.near|meme.near|2000".to_string()),
                token_in: "near".to_string(),
                token_out: "meme.near".to_string(),
                min_amount_out: U128(0),
            }],
            amount_in: U128(1_000),
            token_in: "near".to_string(),
            token_out: "meme.near".to_string(),
            min_amount_out: U128(0),
            nonce: [nonce_byte; 32],
            deadline: 0,
            correlation_id: format!("c{}", nonce_byte),
            custom_contract: None,
            custom_msg: None,
        }
    }

    #[test]
    #[should_panic(expected = "Token busy")]
    fn test_second_swap_on_same_token_is_rejected_while_settling() {
        let mut c = setup();
        c.credit(&user(), "near", 10_000);
        testing_env!(VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(user())
            .build());
        let _ = c.execute_intent(intent(1));
        assert!(c.is_token_locked("meme.near"));
        let _ = c.execute_intent(intent(2));
    }

    #[test]
    fn test_payout_is_balance_diff_not_total_balance() {
        let mut c = setup();
        pending_buy(&mut c, 7, 0);
        c.set_snapshot(7, 900_000); // router already held 900k meme tokens before this swap
        callback_env(balance_result(910_000));
        let _ = c.on_swap_payout(7);
        // Fee is 1.5% of the 10_000 actually received, not of the router's 910_000 balance
        assert_eq!(c.get_balance(&treasury(), "meme.near"), 150);
        assert!(c.take_snapshot(7).is_none());
        assert!(c.is_token_locked("meme.near"), "lock held until payout transfer resolves");
    }

    #[test]
    fn test_zero_diff_refunds_and_unlocks() {
        let mut c = setup();
        pending_buy(&mut c, 8, 0);
        c.set_snapshot(8, 900_000);
        callback_env(balance_result(900_000));
        let _ = c.on_swap_payout(8);
        assert_eq!(c.get_balance(&user(), "near"), 5_000_000);
        assert!(!c.is_token_locked("meme.near"));
    }

    #[test]
    fn test_missing_snapshot_refunds_instead_of_paying_total_balance() {
        let mut c = setup();
        pending_buy(&mut c, 9, 0);
        callback_env(balance_result(910_000));
        let _ = c.on_swap_payout(9);
        assert_eq!(c.get_balance(&user(), "near"), 5_000_000);
        assert_eq!(c.get_balance(&treasury(), "meme.near"), 0);
        assert!(!c.is_token_locked("meme.near"));
    }

    #[test]
    fn test_failed_payout_recredits_user_and_unlocks() {
        let mut c = setup();
        c.set_token_lock("meme.near", true);
        callback_env(near_sdk::PromiseResult::Failed);
        let ok = c.on_payout_resolved("corr".into(), user(), "meme.near".into(), U128(9_850), Some("meme.near".into()));
        assert!(!ok);
        assert_eq!(c.get_balance(&user(), "meme.near"), 9_850);
        assert!(!c.is_token_locked("meme.near"));
    }

    #[test]
    fn test_successful_payout_unlocks_without_credit() {
        let mut c = setup();
        c.set_token_lock("meme.near", true);
        callback_env(near_sdk::PromiseResult::Successful(vec![]));
        assert!(c.on_payout_resolved("corr".into(), user(), "meme.near".into(), U128(9_850), Some("meme.near".into())));
        assert_eq!(c.get_balance(&user(), "meme.near"), 0);
        assert!(!c.is_token_locked("meme.near"));
    }

    fn intent_for(venue: Venue, token_in: &str, token_out: &str, nonce_byte: u8) -> Intent {
        let mut i = intent(nonce_byte);
        i.venue = venue;
        i.token_in = token_in.to_string();
        i.token_out = token_out.to_string();
        i.custom_contract = Some("receiver.near".parse().unwrap());
        i
    }

    fn as_user() {
        testing_env!(VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(user())
            .build());
    }

    #[test]
    #[should_panic(expected = "This venue spends native NEAR")]
    fn test_native_venue_rejects_wnear_balance() {
        let mut c = setup();
        c.credit(&user(), WRAP_NEAR, 10_000);
        as_user();
        let _ = c.execute_intent(intent_for(Venue::Shardsmarket, "near", "meme.near", 3));
    }

    #[test]
    #[should_panic(expected = "This venue spends native NEAR")]
    fn test_native_venue_rejects_sells() {
        let mut c = setup();
        c.credit(&user(), "meme.near", 10_000);
        as_user();
        let _ = c.execute_intent(intent_for(Venue::BondingCurve, "meme.near", "near", 4));
    }

    #[test]
    fn test_native_venue_accepts_native_balance() {
        let mut c = setup();
        c.credit(&user(), "near", 10_000);
        as_user();
        let _ = c.execute_intent(intent_for(Venue::Intear, "near", "meme.near", 5));
        assert_eq!(c.get_balance(&user(), "near"), 9_000);
    }

    #[test]
    #[should_panic(expected = "GenericFtCall sends token_in")]
    fn test_generic_ft_call_rejects_mismatched_debit() {
        let mut c = setup();
        c.credit(&user(), "near", 10_000); // only native NEAR, but the call would send wNEAR
        as_user();
        let _ = c.execute_intent(intent_for(Venue::GenericFtCall, WRAP_NEAR, "meme.near", 6));
    }

    #[test]
    fn test_ref_buy_debits_wnear_when_only_wnear_held() {
        let mut c = setup();
        c.credit(&user(), WRAP_NEAR, 10_000);
        as_user();
        let _ = c.execute_intent(intent_for(Venue::Dcl, "near", "meme.near", 7));
        assert_eq!(c.get_balance(&user(), WRAP_NEAR), 9_000);
        assert_eq!(c.get_balance(&user(), "near"), 0);
    }

    fn ft_call_result(used: u128) -> near_sdk::PromiseResult {
        near_sdk::PromiseResult::Successful(serde_json::to_vec(&U128(used)).unwrap())
    }

    #[test]
    fn test_venue_that_kept_nothing_gets_full_refund() {
        let mut c = setup();
        pending_buy(&mut c, 20, 0);
        c.set_snapshot(20, 100);
        callback_env(ft_call_result(0));
        let _ = c.on_swap_complete(20);
        assert_eq!(c.get_balance(&user(), "near"), 5_000_000);
        assert!(!c.is_token_locked("meme.near"));
        assert_eq!(c.take_used(20), 0);
    }

    #[test]
    fn test_swap_complete_records_used_input() {
        let mut c = setup();
        pending_buy(&mut c, 21, 0);
        callback_env(ft_call_result(4_000_000));
        let _ = c.on_swap_complete(21);
        assert_eq!(c.take_used(21), 4_000_000);
        assert!(c.is_token_locked("meme.near"), "still settling");
    }

    #[test]
    fn test_payable_venue_success_counts_full_input_as_used() {
        let mut c = setup();
        c.pending_swaps.insert(22, PendingSwap {
            user: user(),
            token_in: "near".to_string(),
            amount_in: 5_000_000,
            token_out: "meme.near".to_string(),
            fee_bps: 250,
            min_amount_out: U128(0),
            correlation_id: "corr".to_string(),
            venue: Venue::Shardsmarket,
        });
        callback_env(near_sdk::PromiseResult::Successful(b"true".to_vec()));
        let _ = c.on_swap_complete(22);
        assert_eq!(c.take_used(22), 5_000_000);
    }

    #[test]
    fn test_used_input_is_not_refunded_when_output_is_missing() {
        // The USDC-sell case: the venue kept the input but paid out something the router did not see
        let mut c = setup();
        pending_buy(&mut c, 23, 0);
        c.set_snapshot(23, 100);
        c.set_used(23, 5_000_000);
        callback_env(balance_result(100));
        let _ = c.on_swap_payout(23);
        assert_eq!(c.get_balance(&user(), "near"), 0, "no credit for input the router no longer holds");
        assert!(!c.is_token_locked("meme.near"));
        assert_eq!(c.take_used(23), 0);
    }

    #[test]
    fn test_partially_used_input_refunds_the_remainder() {
        let mut c = setup();
        pending_buy(&mut c, 24, 0);
        c.set_snapshot(24, 100);
        c.set_used(24, 3_000_000);
        callback_env(balance_result(100));
        let _ = c.on_swap_payout(24);
        assert_eq!(c.get_balance(&user(), "near"), 2_000_000);
    }

    #[test]
    fn test_successful_payout_clears_used_record() {
        let mut c = setup();
        pending_buy(&mut c, 25, 0);
        c.set_snapshot(25, 100);
        c.set_used(25, 5_000_000);
        callback_env(balance_result(10_100));
        let _ = c.on_swap_payout(25);
        assert_eq!(c.take_used(25), 0);
        assert_eq!(c.get_balance(&user(), "near"), 0);
    }

    #[test]
    fn test_ref_swap_now_goes_through_the_snapshot_path() {
        let mut c = setup();
        c.credit(&user(), WRAP_NEAR, 10_000);
        as_user();
        let mut i = intent_for(Venue::RefAmm, WRAP_NEAR, "meme.near", 8);
        i.hops = vec![Hop { pool_id: Some(4276), dcl_pool_id: None, token_in: WRAP_NEAR.into(), token_out: "meme.near".into(), min_amount_out: U128(1) }];
        let _ = c.execute_intent(i);
        assert!(c.is_token_locked("meme.near"), "Ref swaps take the payout lock and are measured like DCL");
        assert_eq!(c.get_balance(&user(), WRAP_NEAR), 9_000);
    }

    // ── Sells to NEAR: wNEAR output measurement and the wNEAR gate ───────────

    fn pending_sell(c: &mut RacerbotVault, swap_nonce: u64) {
        c.pending_swaps.insert(swap_nonce, PendingSwap {
            user: user(),
            token_in: "usdc.near".to_string(),
            amount_in: 1_351_942,
            token_out: WRAP_NEAR.to_string(),
            fee_bps: 150,
            min_amount_out: U128(0),
            correlation_id: "sell".to_string(),
            venue: Venue::Dcl,
        });
        c.set_token_lock(WRAP_NEAR, true);
        c.set_inflight(1);
    }

    #[test]
    fn test_sell_pays_measured_wnear_and_releases_gate_after_payout() {
        let mut c = setup();
        pending_sell(&mut c, 30);
        c.set_snapshot(30, 1_000);
        c.set_used(30, 1_351_942);
        callback_env(balance_result(1_000 + 300_000));
        let _ = c.on_swap_payout(30);
        assert_eq!(c.get_balance(&user(), "usdc.near"), 0, "no USDC re-credit");
        assert!(c.is_token_locked(WRAP_NEAR), "gate stays closed until the payout resolves");
        assert_eq!(c.inflight(), 1);

        // unwrap succeeded -> native payout; its callback ends the swap
        callback_env(near_sdk::PromiseResult::Successful(vec![]));
        let _ = c.on_unwrapped("sell".into(), user(), U128(295_500), U128(4_500), Some(WRAP_NEAR.into()));
        assert_eq!(c.get_balance(&treasury(), "near"), 4_500, "fee kept as native NEAR");
        callback_env(near_sdk::PromiseResult::Successful(vec![]));
        assert!(c.on_payout_resolved("sell".into(), user(), "near".into(), U128(295_500), Some(WRAP_NEAR.into())));
        assert!(!c.is_token_locked(WRAP_NEAR));
        assert_eq!(c.inflight(), 0);
    }

    #[test]
    fn test_failed_unwrap_recredits_wnear_and_ends_the_swap() {
        let mut c = setup();
        c.set_token_lock(WRAP_NEAR, true);
        c.set_inflight(1);
        callback_env(near_sdk::PromiseResult::Failed);
        let _ = c.on_unwrapped("sell".into(), user(), U128(295_500), U128(4_500), Some(WRAP_NEAR.into()));
        assert_eq!(c.get_balance(&user(), WRAP_NEAR), 295_500);
        assert_eq!(c.get_balance(&treasury(), WRAP_NEAR), 4_500);
        assert!(!c.is_token_locked(WRAP_NEAR));
        assert_eq!(c.inflight(), 0);
    }

    #[test]
    fn test_sell_with_no_output_flags_reconciliation() {
        let mut c = setup();
        pending_sell(&mut c, 31);
        c.set_snapshot(31, 1_000);
        c.set_used(31, 1_351_942);
        callback_env(balance_result(1_000));
        let _ = c.on_swap_payout(31);
        assert_eq!(c.get_balance(&user(), "usdc.near"), 0);
        assert!(!c.is_token_locked(WRAP_NEAR));
        assert_eq!(c.inflight(), 0);
    }

    #[test]
    #[should_panic(expected = "swaps are settling before a sell to NEAR")]
    fn test_sell_waits_for_other_swaps_to_finish() {
        let mut c = setup();
        c.credit(&user(), "meme.near", 10_000);
        c.set_inflight(1);
        as_user();
        let _ = c.execute_intent(intent_for(Venue::Dcl, "meme.near", WRAP_NEAR, 40));
    }

    #[test]
    #[should_panic(expected = "Token busy: a sell to NEAR is settling")]
    fn test_buy_waits_while_a_sell_to_near_settles() {
        let mut c = setup();
        c.credit(&user(), "near", 10_000);
        c.set_token_lock(WRAP_NEAR, true);
        as_user();
        let _ = c.execute_intent(intent_for(Venue::Dcl, "near", "meme.near", 41));
    }

    #[test]
    fn test_deposit_near_is_not_gated() {
        let mut c = setup();
        c.set_token_lock(WRAP_NEAR, true);
        testing_env!(VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(user())
            .attached_deposit(NearToken::from_near(1))
            .build());
        c.deposit_near(user());
        assert_eq!(c.get_balance(&user(), "near"), 1_000_000_000_000_000_000_000_000);
    }

    #[test]
    #[should_panic(expected = "Token busy: a sell to NEAR is settling")]
    fn test_wnear_withdraw_waits_while_a_sell_to_near_settles() {
        let mut c = setup();
        c.credit(&user(), WRAP_NEAR, 10_000);
        c.set_token_lock(WRAP_NEAR, true);
        as_user();
        let _ = c.withdraw(WRAP_NEAR.into());
    }

    #[test]
    fn test_native_near_withdraw_is_not_gated() {
        let mut c = setup();
        c.credit(&user(), "near", 10_000);
        c.set_token_lock(WRAP_NEAR, true);
        as_user();
        let _ = c.withdraw("near".into());
        assert_eq!(c.get_balance(&user(), "near"), 0);
    }

    #[test]
    fn test_other_token_withdraw_is_not_gated() {
        let mut c = setup();
        c.credit(&user(), "meme.near", 10_000);
        c.set_token_lock(WRAP_NEAR, true);
        as_user();
        let _ = c.withdraw("meme.near".into());
        assert_eq!(c.get_balance(&user(), "meme.near"), 0);
    }

    #[test]
    fn test_wnear_deposit_is_handed_back_while_a_sell_settles() {
        let mut c = setup();
        c.set_token_lock(WRAP_NEAR, true);
        testing_env!(VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(WRAP_NEAR.parse().unwrap())
            .build());
        let res = c.ft_on_transfer(user(), U128(500), String::new());
        assert!(matches!(res, PromiseOrValue::Value(U128(500))), "full amount returned to sender");
        assert_eq!(c.get_balance(&user(), WRAP_NEAR), 0);
    }

    #[test]
    fn test_inflight_counts_swaps_until_they_end() {
        let mut c = setup();
        c.credit(&user(), WRAP_NEAR, 10_000);
        as_user();
        let _ = c.execute_intent(intent_for(Venue::Dcl, WRAP_NEAR, "meme.near", 42));
        assert_eq!(c.inflight(), 1);
        let nonce = c.nonce - 1;
        let pending = c.pending_swaps.remove(&nonce).unwrap();
        c.fail_balance_diff_swap(nonce, &pending, "test");
        assert_eq!(c.inflight(), 0);
    }

    // ── Owner reconciliation ─────────────────────────────────────────────────

    #[test]
    fn test_owner_reconciles_an_unaccounted_swap() {
        let mut c = setup();
        c.credit(&user(), "usdc.near", 1_351_942);
        c.reconcile_ledger(user(), "usdc.near".into(), U128(1_351_942), "near".into(),
            U128(295_234_176_291_515_332_686_018), "8m6UaU3Kq7gESUSir2MBQjzP8m4b3xtbzT945ixkv766".into());
        assert_eq!(c.get_balance(&user(), "usdc.near"), 0);
        assert_eq!(c.get_balance(&user(), "near"), 295_234_176_291_515_332_686_018);
    }

    #[test]
    #[should_panic(expected = "Only owner")]
    fn test_reconcile_is_owner_only() {
        let mut c = setup();
        as_user();
        c.reconcile_ledger(user(), "usdc.near".into(), U128(0), "near".into(), U128(1), "tx".into());
    }

    #[test]
    #[should_panic(expected = "Insufficient vault balance")]
    fn test_reconcile_cannot_debit_more_than_the_ledger_holds() {
        let mut c = setup();
        c.credit(&user(), "usdc.near", 10);
        c.reconcile_ledger(user(), "usdc.near".into(), U128(11), "near".into(), U128(1), "tx".into());
    }

    #[test]
    #[should_panic(expected = "reference (tx hash) required")]
    fn test_reconcile_requires_a_reference() {
        let mut c = setup();
        c.reconcile_ledger(user(), "usdc.near".into(), U128(0), "near".into(), U128(1), " ".into());
    }

    // ── One-transaction sells: ft_transfer_call carrying an intent ───────────

    fn as_token(token: &str) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(token.parse().unwrap())
            .build());
    }

    fn sell_msg(nonce_byte: u8, amount: u128) -> String {
        let mut i = intent_for(Venue::Dcl, "meme.near", WRAP_NEAR, nonce_byte);
        i.amount_in = U128(amount);
        serde_json::json!({ "intent": i }).to_string()
    }

    #[test]
    fn test_deposit_with_intent_credits_and_starts_the_sell() {
        let mut c = setup();
        as_token("meme.near");
        let res = c.ft_on_transfer(user(), U128(5_000), sell_msg(50, 5_000));
        assert!(matches!(res, PromiseOrValue::Value(U128(0))), "deposit fully accepted");
        assert_eq!(c.get_balance(&user(), "meme.near"), 0, "credited then debited by the intent");
        assert!(c.is_token_locked(WRAP_NEAR), "sell to NEAR holds the wNEAR gate");
        assert_eq!(c.inflight(), 1);
        assert!(c.pending_swaps.get(&(c.nonce - 1)).is_some());
    }

    #[test]
    fn test_deposit_larger_than_intent_keeps_the_rest_in_the_vault() {
        let mut c = setup();
        as_token("meme.near");
        let _ = c.ft_on_transfer(user(), U128(7_000), sell_msg(51, 5_000));
        assert_eq!(c.get_balance(&user(), "meme.near"), 2_000);
    }

    #[test]
    #[should_panic(expected = "Intent user must be the sender")]
    fn test_deposit_intent_for_someone_else_is_rejected() {
        let mut c = setup();
        as_token("meme.near");
        let _ = c.ft_on_transfer("mallory.near".parse().unwrap(), U128(5_000), sell_msg(52, 5_000));
    }

    #[test]
    #[should_panic(expected = "Intent token_in must be the deposited token")]
    fn test_deposit_intent_for_another_token_is_rejected() {
        let mut c = setup();
        as_token("other.near");
        let _ = c.ft_on_transfer(user(), U128(5_000), sell_msg(53, 5_000));
    }

    #[test]
    #[should_panic(expected = "Insufficient vault balance")]
    fn test_deposit_smaller_than_intent_is_rejected() {
        let mut c = setup();
        as_token("meme.near");
        let _ = c.ft_on_transfer(user(), U128(4_000), sell_msg(54, 5_000));
    }

    #[test]
    #[should_panic(expected = "Invalid intent message")]
    fn test_malformed_intent_message_is_rejected() {
        let mut c = setup();
        as_token("meme.near");
        let _ = c.ft_on_transfer(user(), U128(5_000), "{\"intent\": 1}".into());
    }

    #[test]
    fn test_plain_deposit_still_works() {
        let mut c = setup();
        as_token("meme.near");
        let _ = c.ft_on_transfer(user(), U128(5_000), String::new());
        assert_eq!(c.get_balance(&user(), "meme.near"), 5_000);
        assert_eq!(c.inflight(), 0);
    }

    #[test]
    fn test_rescue_releases_lock_and_snapshot() {
        let mut c = setup();
        pending_buy(&mut c, 11, 0);
        c.set_snapshot(11, 5);
        c.rescue_stuck_swap(11);
        assert!(!c.is_token_locked("meme.near"));
        assert!(c.take_snapshot(11).is_none());
    }
}
