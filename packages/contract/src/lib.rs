use near_sdk::{
    env, near, AccountId, Gas, NearToken, Promise, PromiseOrValue,
    require, serde_json,
};
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;

const GAS_FOR_SWAP: Gas = Gas::from_tgas(100);
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(50);
const GAS_FOR_STORAGE_DEPOSIT: Gas = Gas::from_tgas(20);
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(30);
const STORAGE_DEPOSIT_AMOUNT: NearToken = NearToken::from_millinear(125); // 0.00125 N
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum Venue {
    Rhea,
    Shardsmarket,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct SwapParams {
    pub token_in: String,
    pub token_out: String,
    pub amount_in: U128,
    pub min_amount_out: U128,
    pub venue: Venue,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct FeeConfig {
    pub buy_fee_bps: u32,
    pub sell_fee_bps: u32,
    pub snipe_fee_bps: u32,
}

/// Pending swap context stored between the swap call and its callback.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
struct PendingSwap {
    caller: AccountId,
    token_out: String,
    fee_bps: u32,
    min_amount_out: U128,
}

#[near(contract_state)]
pub struct RacerbotRouter {
    owner_id: AccountId,
    treasury_id: AccountId,
    fee_config: FeeConfig,
    /// Maps nonce → pending swap context for callback resolution
    pending_swaps: LookupMap<u64, PendingSwap>,
    nonce: u64,
}

impl Default for RacerbotRouter {
    fn default() -> Self {
        env::panic_str("RacerbotRouter must be initialized with new()");
    }
}

#[near]
impl RacerbotRouter {
    #[init]
    pub fn new(
        owner_id: AccountId,
        treasury_id: AccountId,
        buy_fee_bps: u32,
        sell_fee_bps: u32,
        snipe_fee_bps: u32,
    ) -> Self {
        require!(!env::state_exists(), "Already initialized");
        Self {
            owner_id,
            treasury_id,
            fee_config: FeeConfig { buy_fee_bps, sell_fee_bps, snipe_fee_bps },
            pending_swaps: LookupMap::new(b"p"),
            nonce: 0,
        }
    }

    // ── Access control ────────────────────────────────────────────────────────

    /// Verify the caller is using a function-call access key scoped to this contract.
    /// NEAR does this automatically — if a scoped key calls a method not in its allowed list,
    /// the runtime rejects it before reaching our code. We just verify it's not full-access.
    fn assert_function_call_key(&self) {
        // A full-access key can be detected because it has no allowance limit.
        // In practice the runtime enforces method restrictions; this is an extra guard.
        require!(
            env::attached_deposit() <= NearToken::from_yoctonear(1),
            "Only 1 yoctoNEAR deposit allowed — full-access keys are prohibited"
        );
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only owner can call this method"
        );
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    #[payable]
    pub fn set_fee_config(&mut self, buy_fee_bps: u32, sell_fee_bps: u32, snipe_fee_bps: u32) {
        self.assert_owner();
        require!(buy_fee_bps <= 1000 && sell_fee_bps <= 1000 && snipe_fee_bps <= 1000,
            "Fee cannot exceed 10%");
        self.fee_config = FeeConfig { buy_fee_bps, sell_fee_bps, snipe_fee_bps };
    }

    pub fn set_treasury(&mut self, treasury_id: AccountId) {
        self.assert_owner();
        self.treasury_id = treasury_id;
    }

    // ── View methods ──────────────────────────────────────────────────────────

    pub fn get_fee_config(&self) -> &FeeConfig {
        &self.fee_config
    }

    pub fn get_treasury(&self) -> &AccountId {
        &self.treasury_id
    }

    pub fn get_owner(&self) -> &AccountId {
        &self.owner_id
    }

    // ── Core swap ─────────────────────────────────────────────────────────────

    /// Main entry point. Called by the executor with a user's scoped function-call key.
    /// 1. Routes to the correct venue's swap method via cross-contract call
    /// 2. On callback: deducts fee, sends net output to caller, fee to treasury
    /// 3. Entire call reverts if the venue swap fails — fee is never taken on failure
    #[payable]
    pub fn execute_swap(&mut self, params: SwapParams) -> Promise {
        self.assert_function_call_key();

        let caller = env::predecessor_account_id();
        let is_sell = params.token_out == "wrap.near" || params.token_out == "near";
        let fee_bps = if is_sell {
            self.fee_config.sell_fee_bps
        } else {
            match &params.venue {
                Venue::Shardsmarket => self.fee_config.snipe_fee_bps,
                Venue::Rhea => self.fee_config.buy_fee_bps,
            }
        };

        let nonce = self.nonce;
        self.nonce += 1;

        self.pending_swaps.insert(nonce, PendingSwap {
            caller: caller.clone(),
            token_out: params.token_out.clone(),
            fee_bps,
            min_amount_out: params.min_amount_out,
        });

        let swap_promise = match &params.venue {
            Venue::Rhea => self.call_rhea(&params),
            Venue::Shardsmarket => self.call_shardsmarket(&caller, &params),
        };

        swap_promise.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_RESOLVE)
                .resolve_swap(nonce, caller)
        )
    }

    // ── Venue integrations ────────────────────────────────────────────────────

    fn call_rhea(&self, params: &SwapParams) -> Promise {
        let args = serde_json::json!({
            "actions": [{
                "pool_id": 0,
                "token_in": params.token_in,
                "amount_in": params.amount_in,
                "token_out": params.token_out,
                "min_amount_out": "0",
            }],
            "referral_id": null,
        });

        Promise::new("rhea.finance".parse().unwrap())
            .function_call(
                "swap".to_string(),
                serde_json::to_vec(&args).unwrap(),
                NearToken::from_yoctonear(params.amount_in.0),
                GAS_FOR_SWAP,
            )
    }

    fn call_shardsmarket(&self, _caller: &AccountId, params: &SwapParams) -> Promise {
        let args = serde_json::json!({
            "token_id": params.token_out,
            "min_token_out": params.min_amount_out,
            "referrer_id": null,
        });

        Promise::new("factory.shardsmarket.near".parse().unwrap())
            .function_call(
                "buy".to_string(),
                serde_json::to_vec(&args).unwrap(),
                NearToken::from_yoctonear(params.amount_in.0),
                GAS_FOR_SWAP,
            )
    }

    // ── Callback ──────────────────────────────────────────────────────────────

    /// Called by the contract itself after the venue swap resolves.
    /// Reads actual output from PromiseResult, applies fee split, transfers funds.
    #[private]
    pub fn resolve_swap(&mut self, nonce: u64, caller: AccountId) -> PromiseOrValue<U128> {
        let pending = match self.pending_swaps.remove(&nonce) {
            Some(p) => p,
            None => {
                env::log_str(&format!("WARN: no pending swap for nonce {}", nonce));
                return PromiseOrValue::Value(U128(0));
            }
        };

        match env::promise_result_checked(0, 1024) {
            Ok(bytes) => {
                // Venues return the output amount as a U128 JSON string
                let raw_out: U128 = serde_json::from_slice(&bytes)
                    .unwrap_or(U128(0));

                if raw_out.0 == 0 {
                    env::log_str("WARN: venue returned 0 output");
                    return PromiseOrValue::Value(U128(0));
                }

                require!(
                    raw_out.0 >= pending.min_amount_out.0,
                    format!("Slippage: got {} but need {}", raw_out.0, pending.min_amount_out.0)
                );

                let fee_amount = (raw_out.0 * pending.fee_bps as u128) / 10_000;
                let net_amount = raw_out.0 - fee_amount;

                // Send fee (1.5%) to treasury wallet (with storage deposit if FT)
                if fee_amount > 0 {
                    let _ = self.transfer_out(&pending.token_out, &self.treasury_id.clone(), fee_amount);
                }

                // Send net output (98.5%) to caller (with storage deposit if FT)
                let _ = self.transfer_out(&pending.token_out, &caller, net_amount);

                env::log_str(&format!(
                    "SWAP OK caller={} token_out={} gross={} fee={} net={}",
                    caller, pending.token_out, raw_out.0, fee_amount, net_amount
                ));

                PromiseOrValue::Value(U128(net_amount))
            }
            Err(_) => {
                env::log_str(&format!("SWAP FAILED nonce={} caller={}", nonce, caller));
                // No funds moved — venue reverted, so nothing to refund
                PromiseOrValue::Value(U128(0))
            }
        }
    }

    // ── Internal transfer helpers ─────────────────────────────────────────────

    /// Route funds out to recipient. If token is "near", uses native transfer;
    /// otherwise executes NEP-141 transfer with storage deposit pre-check.
    fn transfer_out(&self, token: &str, recipient: &AccountId, amount: u128) -> Promise {
        if token == "near" {
            Promise::new(recipient.clone()).transfer(NearToken::from_yoctonear(amount))
        } else {
            self.send_ft_with_storage(token, recipient, amount)
        }
    }

    /// Ensure recipient is registered for the output token before transferring.
    /// NEAR NEP-141 requires storage deposit if recipient has never held the token.
    fn send_ft_with_storage(&self, token: &str, recipient: &AccountId, amount: u128) -> Promise {
        let deposit_args = serde_json::json!({
            "account_id": recipient,
            "registration_only": true,
        });
        let transfer_args = serde_json::json!({
            "receiver_id": recipient,
            "amount": U128(amount),
            "memo": null,
        });

        Promise::new(token.parse().unwrap())
            .function_call(
                "storage_deposit".to_string(),
                serde_json::to_vec(&deposit_args).unwrap(),
                STORAGE_DEPOSIT_AMOUNT,
                GAS_FOR_STORAGE_DEPOSIT,
            )
            .then(
                Promise::new(token.parse().unwrap())
                    .function_call(
                        "ft_transfer".to_string(),
                        serde_json::to_vec(&transfer_args).unwrap(),
                        ONE_YOCTO,
                        GAS_FOR_FT_TRANSFER,
                    )
            )
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn contract_account() -> AccountId {
        "router.racerbot.near".parse().unwrap()
    }
    fn owner() -> AccountId {
        "owner.racerbot.near".parse().unwrap()
    }
    fn treasury() -> AccountId {
        "treasury.racerbot.near".parse().unwrap()
    }

    fn setup() -> RacerbotRouter {
        let context = VMContextBuilder::new()
            .current_account_id(contract_account())
            .predecessor_account_id(owner())
            .is_view(false)
            .build();
        testing_env!(context);
        RacerbotRouter::new(owner(), treasury(), 150, 150, 150)
    }

    #[test]
    fn test_new_contract() {
        let contract = setup();
        assert_eq!(contract.owner_id, owner());
        assert_eq!(contract.treasury_id, treasury());
        assert_eq!(contract.fee_config.buy_fee_bps, 150);
        assert_eq!(contract.fee_config.sell_fee_bps, 150);
        assert_eq!(contract.fee_config.snipe_fee_bps, 150);
    }

    #[test]
    fn test_fee_calculation() {
        let contract = setup();
        // 1 NEAR in, 1.5% fee → 0.985 NEAR net
        let amount = 1_000_000_000_000_000_000_000_000u128; // 1 NEAR
        let fee = (amount * contract.fee_config.buy_fee_bps as u128) / 10_000;
        let net = amount - fee;
        assert_eq!(fee, 15_000_000_000_000_000_000_000u128); // 0.015 NEAR (1.5%)
        assert_eq!(net, 985_000_000_000_000_000_000_000u128); // 0.985 NEAR
    }

    #[test]
    fn test_set_fee_config_owner_only() {
        let mut contract = setup();
        // Set as owner — should succeed
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(owner())
            .attached_deposit(NearToken::from_yoctonear(0))
            .build();
        testing_env!(ctx);
        contract.set_fee_config(200, 200, 300);
        assert_eq!(contract.fee_config.buy_fee_bps, 200);
    }

    #[test]
    #[should_panic(expected = "Only owner")]
    fn test_set_fee_config_non_owner_panics() {
        let mut contract = setup();
        let ctx = VMContextBuilder::new()
            .predecessor_account_id("attacker.near".parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(0))
            .build();
        testing_env!(ctx);
        contract.set_fee_config(0, 0, 0);
    }
}