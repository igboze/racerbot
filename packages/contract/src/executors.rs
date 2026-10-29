//! Position executors: one keyless subaccount per confidential position (see packages/position-executor).
//!
//! The router creates executors from the shared global contract, forwards the relayer's trade
//! instructions to them, and collects their fees. It never holds executor funds. State lives under
//! raw `x:` storage keys so the existing vault state layout is untouched.

use crate::{RacerbotVault, RacerbotVaultExt};
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{env, near, require, serde_json, AccountId, CryptoHash, Gas, NearToken, Promise};

const GAS_EXEC_TRADE: Gas = Gas::from_tgas(250);
const GAS_EXEC_EXIT: Gas = Gas::from_tgas(100);
const GAS_EXEC_INIT: Gas = Gas::from_tgas(10);
const GAS_EXEC_CB: Gas = Gas::from_tgas(10);
/// Executor fee cap, mirrored from the executor contract
const EXECUTOR_MAX_FEE_BPS: u32 = 200;
/// Sell rate for proceeds above the bot's $200 threshold
const DEFAULT_LARGE_SELL_FEE_BPS: u32 = 200;

const KEY_CODE: &[u8] = b"x:code";
const KEY_FEES: &[u8] = b"x:fees";
const KEY_LARGE_SELL: &[u8] = b"x:sell_large";

fn relayer_key(account: &AccountId) -> Vec<u8> {
    [b"x:r:".as_slice(), account.as_bytes()].concat()
}

fn executor_key(account: &AccountId) -> Vec<u8> {
    [b"x:e:".as_slice(), account.as_bytes()].concat()
}

// Trade plans arrive borsh-encoded (the executor's SwapPlan) and are forwarded untouched: the
// executor validates every field, so the router never needs to decode them.

#[derive(BorshSerialize, BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
struct NewArgs {
    router: AccountId,
    owner_hash: Vec<u8>,
}

#[near]
impl RacerbotVault {
    // ═══════════════════════════ ADMIN ═══════════════════════════════════════

    /// Code hash (hex) of the executor global contract (deployed separately with DeployGlobalContract)
    pub fn set_executor_code(&mut self, code_hash: String) {
        self.assert_owner_only();
        let hash: CryptoHash = decode_hex32(&code_hash);
        env::storage_write(KEY_CODE, &hash);
        Self::emit("executor_code_set", serde_json::json!({ "code_hash": code_hash }));
    }

    /// Accounts allowed to drive executors (the backend's relayer)
    pub fn set_relayer(&mut self, account_id: AccountId, allowed: bool) {
        self.assert_owner_only();
        if allowed {
            env::storage_write(&relayer_key(&account_id), &[1]);
        } else {
            env::storage_remove(&relayer_key(&account_id));
        }
        Self::emit("relayer_set", serde_json::json!({ "account_id": account_id, "allowed": allowed }));
    }

    /// Sell rate charged when proceeds exceed the $200 threshold (default 200 bps)
    pub fn set_large_sell_fee_bps(&mut self, bps: u32) {
        self.assert_owner_only();
        require!(bps <= EXECUTOR_MAX_FEE_BPS, "Above executor maximum");
        env::storage_write(KEY_LARGE_SELL, &bps.to_le_bytes());
    }

    // ═══════════════════════════ EXECUTORS ═══════════════════════════════════

    /// Create `<name>.<router>` running the executor code, owned by `owner_hash` (hex sha256 of salt + payout address).
    /// The attached deposit funds the account's storage.
    #[payable]
    pub fn create_executor(&mut self, name: String, owner_hash: String) -> Promise {
        self.assert_executor_caller();
        let account = self.executor_account(&name);
        require!(env::storage_read(&executor_key(&account)).is_none(), "Executor already exists");
        self.spawn_executor(account, owner_hash)
    }

    /// Rescue: re-create a deleted executor at the same name so stranded funds can be swept to its owner
    #[payable]
    pub fn recreate_executor(&mut self, name: String, owner_hash: String) -> Promise {
        self.assert_owner_only();
        let account = self.executor_account(&name);
        self.spawn_executor(account, owner_hash)
    }

    #[private]
    pub fn on_executor_created(&mut self, executor: AccountId) -> bool {
        let ok = env::promise_result_checked(0, 64).is_ok();
        if !ok {
            env::storage_remove(&executor_key(&executor));
        }
        Self::emit(if ok { "executor_created" } else { "executor_create_failed" },
            serde_json::json!({ "executor": executor }));
        ok
    }

    /// `plan`: the executor's SwapPlan, borsh-encoded
    pub fn exec_buy(&mut self, executor: AccountId, plan: Base64VecU8, fee_bps: u32) -> Promise {
        self.assert_executor_caller();
        self.assert_executor(&executor);
        require!(fee_bps == self.fee_config.buy_fee_bps, "Buy fee must match fee_config");
        let mut args = plan.0;
        args.extend_from_slice(&fee_bps.to_le_bytes());
        Self::call_executor(executor, "buy", args, GAS_EXEC_TRADE)
    }

    pub fn exec_sell(&mut self, executor: AccountId, plan: Base64VecU8) -> Promise {
        self.assert_executor_caller();
        self.assert_executor(&executor);
        Self::call_executor(executor, "sell", plan.0, GAS_EXEC_TRADE)
    }

    /// Measure the executor's NEAR and charge the sell fee: the standard rate, or the large-sell rate
    pub fn exec_prepare_exit(&mut self, executor: AccountId, fee_bps: u32) -> Promise {
        self.assert_executor_caller();
        self.assert_executor(&executor);
        require!(fee_bps == self.fee_config.sell_fee_bps || fee_bps == self.large_sell_fee_bps(),
            "Sell fee must match fee_config");
        Self::call_executor(executor, "prepare_exit", fee_bps.to_le_bytes().to_vec(), GAS_EXEC_EXIT)
    }

    pub fn exec_exit_to_intents(&mut self, executor: AccountId, deposit_address: AccountId, amount: U128) -> Promise {
        self.assert_executor_caller();
        self.assert_executor(&executor);
        let args = borsh::to_vec(&(deposit_address, amount.0)).unwrap();
        Self::call_executor(executor, "exit_to_intents", args, GAS_EXEC_EXIT)
    }

    pub fn exec_exit_to_owner(&mut self, executor: AccountId, to: AccountId, salt: String) -> Promise {
        self.assert_executor_caller();
        self.assert_executor(&executor);
        let args = borsh::to_vec(&(to, salt)).unwrap();
        Self::call_executor(executor, "exit_to_owner", args, GAS_EXEC_EXIT)
    }

    pub fn exec_send_token_to_owner(&mut self, executor: AccountId, token: AccountId, to: AccountId, salt: String) -> Promise {
        self.assert_executor_caller();
        self.assert_executor(&executor);
        let args = borsh::to_vec(&(token, to, salt)).unwrap();
        Self::call_executor(executor, "send_token_to_owner", args, GAS_EXEC_EXIT)
    }

    // ═══════════════════════════ FEES ════════════════════════════════════════

    /// Executors pay their fee here (attached NEAR); fees reach the treasury in batches
    #[payable]
    pub fn collect_fee(&mut self) {
        let executor = env::predecessor_account_id();
        require!(env::storage_read(&executor_key(&executor)).is_some(), "Only executors pay fees");
        let amount = env::attached_deposit().as_yoctonear();
        self.set_executor_fees(self.executor_fees_raw() + amount);
        Self::emit("executor_fee", serde_json::json!({ "executor": executor, "amount": U128(amount) }));
    }

    /// Send accrued executor fees to the treasury in one transfer
    pub fn sweep_executor_fees(&mut self) -> Promise {
        self.assert_executor_caller();
        let amount = self.executor_fees_raw();
        require!(amount > 0, "No fees to sweep");
        self.set_executor_fees(0);
        Promise::new(self.treasury_id.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_EXEC_CB).on_fees_swept(U128(amount)))
    }

    #[private]
    pub fn on_fees_swept(&mut self, amount: U128) -> bool {
        let ok = env::promise_result_checked(0, 64).is_ok();
        if !ok {
            self.set_executor_fees(self.executor_fees_raw() + amount.0);
        }
        Self::emit(if ok { "executor_fees_swept" } else { "executor_fees_sweep_failed" },
            serde_json::json!({ "treasury": self.treasury_id, "amount": amount }));
        ok
    }

    // ═══════════════════════════ VIEWS ═══════════════════════════════════════

    pub fn executor_owner_hash(&self, executor: AccountId) -> Option<String> {
        env::storage_read(&executor_key(&executor)).map(|h| to_hex(&h))
    }

    pub fn executor_fees(&self) -> U128 {
        U128(self.executor_fees_raw())
    }

    /// Executor code hash, hex
    pub fn executor_code(&self) -> Option<String> {
        env::storage_read(KEY_CODE).map(|h| to_hex(&h))
    }

    pub fn is_relayer(&self, account_id: AccountId) -> bool {
        env::storage_read(&relayer_key(&account_id)).is_some()
    }

    pub fn get_large_sell_fee_bps(&self) -> u32 {
        self.large_sell_fee_bps()
    }
}

impl RacerbotVault {
    fn assert_owner_only(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
    }

    /// The owner or an allowed relayer, while not paused
    fn assert_executor_caller(&self) {
        require!(!self.paused, "Contract is paused");
        let caller = env::predecessor_account_id();
        require!(caller == self.owner_id || env::storage_read(&relayer_key(&caller)).is_some(), "Only owner or relayer");
    }

    fn assert_executor(&self, executor: &AccountId) {
        require!(env::storage_read(&executor_key(executor)).is_some(), "Unknown executor");
    }

    fn executor_account(&self, name: &str) -> AccountId {
        require!((8..=32).contains(&name.len()) && name.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()),
            "Executor name: 8-32 lowercase letters or digits");
        format!("{}.{}", name, env::current_account_id()).parse().unwrap()
    }

    fn spawn_executor(&mut self, account: AccountId, owner_hash: String) -> Promise {
        let hash = decode_hex32(&owner_hash);
        let code: CryptoHash = env::storage_read(KEY_CODE)
            .and_then(|v| v.try_into().ok())
            .unwrap_or_else(|| env::panic_str("Executor code not set"));
        let deposit = env::attached_deposit();
        require!(deposit.as_yoctonear() > 0, "Attach NEAR for the executor's storage");
        env::storage_write(&executor_key(&account), &hash);
        let init = borsh::to_vec(&NewArgs { router: env::current_account_id(), owner_hash: hash.to_vec() }).unwrap();
        Promise::new(account.clone())
            .create_account()
            .transfer(deposit)
            .use_global_contract(code)
            .function_call("new".to_string(), init, NearToken::from_yoctonear(0), GAS_EXEC_INIT)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_EXEC_CB).on_executor_created(account))
    }

    fn call_executor(executor: AccountId, method: &str, args: Vec<u8>, gas: Gas) -> Promise {
        Promise::new(executor).function_call(method.to_string(), args, NearToken::from_yoctonear(0), gas)
    }

    fn executor_fees_raw(&self) -> u128 {
        env::storage_read(KEY_FEES).and_then(|v| v.try_into().ok()).map(u128::from_le_bytes).unwrap_or(0)
    }

    fn set_executor_fees(&mut self, amount: u128) {
        env::storage_write(KEY_FEES, &amount.to_le_bytes());
    }

    fn large_sell_fee_bps(&self) -> u32 {
        env::storage_read(KEY_LARGE_SELL)
            .and_then(|v| v.try_into().ok())
            .map(u32::from_le_bytes)
            .unwrap_or(DEFAULT_LARGE_SELL_FEE_BPS)
    }
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn decode_hex32(s: &str) -> [u8; 32] {
    let s = s.trim();
    require!(s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()), "Hash must be 64 hex characters");
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

#[cfg(test)]
mod tests;
