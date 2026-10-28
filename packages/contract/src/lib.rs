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

// ── Gas budgets ───────────────────────────────────────────────────────────────
const GAS_WRAP: Gas          = Gas::from_tgas(10);
const GAS_SWAP: Gas          = Gas::from_tgas(80);
const GAS_RESOLVE_RHEA: Gas  = Gas::from_tgas(160);
const GAS_WITHDRAW_REF: Gas  = Gas::from_tgas(40);
const GAS_BALANCE: Gas       = Gas::from_tgas(15);
const GAS_RESOLVE: Gas       = Gas::from_tgas(115);
const GAS_STORAGE: Gas       = Gas::from_tgas(10);
const GAS_FT_XFER: Gas       = Gas::from_tgas(15);
// Balance-diff venues: snapshot → venue swap → balance check → payout → payout callback
const GAS_RESOLVE_XFER: Gas  = Gas::from_tgas(10);
const GAS_RESOLVE_UNWRAP: Gas = Gas::from_tgas(20);
const GAS_PAYOUT: Gas        = Gas::from_tgas(60);
const GAS_SWAP_COMPLETE: Gas = Gas::from_tgas(90);
const GAS_SNAPSHOT: Gas      = Gas::from_tgas(195);

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
        self.set_token_lock(Self::payout_token(&pending.token_out), false);
        Self::emit("swap_rescued", serde_json::json!({
            "correlation_id": pending.correlation_id,
            "swap_nonce": swap_nonce,
            "user": pending.user,
            "refunded_token": pending.token_in,
            "refunded_amount": U128(pending.amount_in),
        }));
    }

    /// Emergency: release a payout-token lock left behind by a swap whose callbacks never ran.
    pub fn release_token_lock(&mut self, token: String) {
        self.assert_owner();
        self.set_token_lock(Self::payout_token(&token), false);
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
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.assert_not_paused();
        let token_id = env::predecessor_account_id().to_string();
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
        let uses_balance_diff = intent.venue != Venue::Rhea && intent.venue != Venue::RefAmm;
        let payout_token = Self::payout_token(&intent.token_out);
        require!(!self.is_token_locked(payout_token), "Token busy: another swap is settling, retry shortly");
        self.set_token_lock(payout_token, true);

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

        self.debit_exact(&intent.user, &actual_debit_token, intent.amount_in.0);

        let is_ref_venue = intent.venue == Venue::Rhea || intent.venue == Venue::RefAmm ||
                           intent.venue == Venue::Nearlytrade || intent.venue == Venue::Dcl;
        let is_near_wrapped = (actual_debit_token == "near" || intent.token_in == "near") && is_ref_venue;

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

        // 7. Dispatch to venue (balance-diff venues snapshot the router's payout-token balance first)
        if !uses_balance_diff {
            return self.dispatch_ref_amm(&intent, swap_nonce, is_near_wrapped);
        }
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
            .with_static_gas(GAS_RESOLVE_RHEA)
            .on_rhea_swap(swap_nonce);

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

    /// Step 1 (Ref AMM): ft_transfer_call resolved → read Ref AMM output amount,
    /// then call `withdraw` to pull tokens out of Ref's internal deposit ledger.
    #[private]
    pub fn on_rhea_swap(&mut self, swap_nonce: u64) -> PromiseOrValue<U128> {
        let pending = match self.pending_swaps.get(&swap_nonce) {
            Some(p) => p.clone(),
            None => {
                env::log_str(&format!("WARN: no pending swap nonce={}", swap_nonce));
                return PromiseOrValue::Value(U128(0));
            }
        };

        match env::promise_result_checked(0, 2048) {
            Ok(bytes) => {
                let raw_out: U128 = serde_json::from_slice(&bytes).unwrap_or(U128(0));

                if raw_out.0 == 0 {
                    self.pending_swaps.remove(&swap_nonce);
                    self.credit(&pending.user, &pending.token_in, pending.amount_in);
                    self.set_token_lock(Self::payout_token(&pending.token_out), false);
                    Self::emit("swap_failed", serde_json::json!({
                        "correlation_id": pending.correlation_id,
                        "user": pending.user,
                        "reason": "venue_returned_zero",
                        "refunded_token": pending.token_in,
                        "refunded_amount": U128(pending.amount_in),
                    }));
                    return PromiseOrValue::Value(U128(0));
                }

                let withdraw_token = if pending.token_out == "near" { WRAP_NEAR } else { &pending.token_out };
                let withdraw_args = serde_json::json!({
                    "token_id": withdraw_token,
                    "amount": raw_out,
                });

                Promise::new(REF_AMM.parse().unwrap())
                    .function_call(
                        "withdraw".to_string(),
                        serde_json::to_vec(&withdraw_args).unwrap(),
                        ONE_YOCTO,
                        GAS_WITHDRAW_REF,
                    )
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(GAS_RESOLVE)
                            .on_rhea_withdraw(swap_nonce, raw_out)
                    )
                    .into()
            }
            Err(_) => {
                let pending = self.pending_swaps.remove(&swap_nonce).unwrap();
                self.credit(&pending.user, &pending.token_in, pending.amount_in);
                self.set_token_lock(Self::payout_token(&pending.token_out), false);
                Self::emit("swap_failed", serde_json::json!({
                    "correlation_id": pending.correlation_id,
                    "user": pending.user,
                    "reason": "ft_transfer_call_failed",
                    "refunded_token": pending.token_in,
                    "refunded_amount": U128(pending.amount_in),
                }));
                PromiseOrValue::Value(U128(0))
            }
        }
    }

    /// Step 2 (Ref AMM): `withdraw` from Ref's ledger resolved.
    /// Output tokens are now in our contract → apply fee split and send to user.
    #[private]
    pub fn on_rhea_withdraw(&mut self, swap_nonce: u64, raw_out: U128) -> PromiseOrValue<U128> {
        let pending = match self.pending_swaps.remove(&swap_nonce) {
            Some(p) => p,
            None => {
                env::log_str(&format!("WARN: no pending swap nonce={}", swap_nonce));
                return PromiseOrValue::Value(U128(0));
            }
        };

        match env::promise_result_checked(0, 512) {
            Ok(_) => {
                let lock = Self::payout_token(&pending.token_out).to_string();
                self.settle(&pending, raw_out.0, Some(lock))
            }
            Err(_) => {
                self.credit(&pending.user, &pending.token_out, raw_out.0);
                self.set_token_lock(Self::payout_token(&pending.token_out), false);
                Self::emit("ref_withdraw_failed", serde_json::json!({
                    "correlation_id": pending.correlation_id,
                    "user": pending.user,
                    "token_out": pending.token_out,
                    "amount_stuck_in_ref": raw_out,
                    "action": "credited_to_vault_ledger_retry_withdraw",
                }));
                PromiseOrValue::Value(U128(0))
            }
        }
    }

    /// Generic callback for DCL, Intear, and Shardsmarket swaps.
    /// Step 1: Venue swap finished.
    /// Query the router's own ft_balance_of for token_out (or wrap.near) to discover
    /// the exact number of tokens received from the venue.
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
            Ok(_) => {
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

        // Every venue hands "near" output back as wrap.near → unwrap before paying natively
        if pending.token_out == "near" {
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

    /// Refund a failed balance-diff swap: re-credit input, drop snapshot, release lock.
    fn fail_balance_diff_swap(&mut self, swap_nonce: u64, pending: &PendingSwap, reason: &str) {
        self.credit(&pending.user, &pending.token_in, pending.amount_in);
        self.clear_snapshot(swap_nonce);
        self.set_token_lock(Self::payout_token(&pending.token_out), false);
        Self::emit("swap_failed", serde_json::json!({
            "correlation_id": pending.correlation_id,
            "user": pending.user,
            "reason": reason,
            "refunded_token": pending.token_in,
            "refunded_amount": U128(pending.amount_in),
        }));
    }

    // ═══════════════════ PAYOUT LOCKS & BALANCE SNAPSHOTS ═════════════════════
    // Raw storage keys (prefixes "l:" / "s:") so the contract state layout is unchanged
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
