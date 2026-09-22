use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::{env, near_bindgen, Promise, PromiseOrValue, TokenCallback};
use near_sdk::serde::{Serialize, Deserialize};
use near_sdk::json_types::U128;
use std::collections::HashMap;
use std::convert::TryInto;

const DEFAULT_FEE_BPS: u32 = 100; // 1%

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone)]
pub struct SwapParams {
    pub token_in: String,
    pub token_out: String,
    pub amount_in: U128,
    pub min_amount_out: U128,
    pub venue: Venue,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, PartialEq)]
pub enum Venue {
    Rhea,
    Shardsmarket,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone)]
pub struct FeeConfig {
    pub buy_fee_bps: u32,
    pub sell_fee_bps: u32,
    pub snipe_fee_bps: u32,
}

#[near_bindgen]
#[derive(BorshDeserialize, BorshSerialize)]
pub struct RacerbotRouter {
    owner_id: String,
    treasury_id: String,
    fee_config: FeeConfig,
    router_allowance: u128,
    token_meta_cache: HashMap<String, TokenMeta>,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone)]
pub struct TokenMeta {
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
    pub total_supply: U128,
}

#[near_bindgen]
impl RacerbotRouter {
    #[init]
    pub fn new(owner_id: String, treasury_id: String, buy_fee_bps: u32, sell_fee_bps: u32, snipe_fee_bps: u32) -> Self {
        RacerbotRouter {
            owner_id,
            treasury_id,
            fee_config: FeeConfig {
                buy_fee_bps,
                sell_fee_bps,
                snipe_fee_bps,
            },
            router_allowance: 0,
            token_meta_cache: HashMap::new(),
        }
    }

    pub fn execute_swap(&mut self, params: SwapParams) -> PromiseOrValue<bool> {
        let caller_id = env::predecessor_account_id();
        self.verify_scoped_key(&caller_id);

        let swap_result = match params.venue {
            Venue::Rhea => self.call_rhea_swap(&caller_id, &params),
            Venue::Shardsmarket => self.call_shardsmarket_swap(&caller_id, &params),
        };

        match swap_result {
            Ok(output_amount) => {
                let fee_amount = self.calculate_fee(&output_amount, &params);
                let net_amount = output_amount - fee_amount;

                if net_amount < params.min_amount_out {
                    env::panic_str("Slippage protection: output below minimum");
                }

                self.transfer_fee_to_treasury(fee_amount);
                self.transfer_to_caller(net_amount, &params.token_out);
                true.into()
            }
            Err(e) => {
                env::panic_str(&e);
            }
        }
    }

    pub fn set_fee_config(&mut self, buy_fee_bps: u32, sell_fee_bps: u32, snipe_fee_bps: u32) {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Only owner can set fees");
        self.fee_config = FeeConfig {
            buy_fee_bps,
            sell_fee_bps,
            snipe_fee_bps,
        };
    }

    pub fn set_treasury(&mut self, treasury_id: String) {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Only owner can set treasury");
        self.treasury_id = treasury_id;
    }

    pub fn update_token_cache(&mut self, token_address: String, name: String, symbol: String, decimals: u8, total_supply: U128) {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Only owner can update cache");
        self.token_meta_cache.insert(token_address, TokenMeta {
            name,
            symbol,
            decimals,
            total_supply,
        });
    }

    pub fn get_fee_config(&self) -> FeeConfig {
        self.fee_config.clone()
    }

    pub fn get_treasury(&self) -> String {
        self.treasury_id.clone()
    }

    pub fn get_owner(&self) -> String {
        self.owner_id.clone()
    }

    pub fn get_router_allowance(&self) -> U128 {
        U128(self.router_allowance)
    }

    pub fn storage_deposit_register(&mut self, account_id: String) -> Promise {
        let amount = env::storage_byte_cost() * 100;
        near_sdk::promise::Promise::new(account_id)
            .function_call(
                "storage_deposit".to_string(),
                serde_json::to_vec(&serde_json::json!({"registration_only": true})).unwrap(),
                amount,
                0,
                env::current_protocol_version(),
            )
    }

    fn verify_scoped_key(&self, caller_id: &str) {
        let key_type = env::attached_deposit();
        assert!(key_type == near_sdk::KeyType::FunctionCall, "Only function-call keys allowed");
        let method_names = env::function_name().to_vec();
        assert!(method_names.iter().any(|m| m == "execute_swap"), "Method not allowed");
    }

    fn call_rhea_swap(&self, caller: &str, params: &SwapParams) -> Result<U128, String> {
        let rhea_contract = "rhea.farm.near";
        near_sdk::promise::Promise::new(rhea_contract.to_string())
            .function_call(
                "swap".to_string(),
                serde_json::to_vec(&serde_json::json!({
                    "token_in": params.token_in,
                    "token_out": params.token_out,
                    "amount_in": params.amount_in,
                    "min_amount_out": params.min_amount_out,
                    "sender": caller,
                })).map_err(|e| e.to_string())?,
                params.amount_in.0,
                0,
                300_000_000_000_000,
            )
            .then(near_sdk::promise::Promise::new(env::current_account_id())
                .function_call(
                    "resolve_rhea_swap".to_string(),
                    vec![],
                    0,
                    0,
                    300_000_000_000_000,
                ))
            .into();
        Ok(U128(0))
    }

    fn call_shardsmarket_swap(&self, caller: &str, params: &SwapParams) -> Result<U128, String> {
        let shardsmarket_contract = "factory.shardsmarket.near";
        near_sdk::promise::Promise::new(shardsmarket_contract.to_string())
            .function_call(
                "swap".to_string(),
                serde_json::to_vec(&serde_json::json!({
                    "token_in": params.token_in,
                    "token_out": params.token_out,
                    "amount_in": params.amount_in,
                    "min_amount_out": params.min_amount_out,
                    "sender": caller,
                })).map_err(|e| e.to_string())?,
                params.amount_in.0,
                0,
                300_000_000_000_000,
            )
            .then(near_sdk::promise::Promise::new(env::current_account_id())
                .function_call(
                    "resolve_shardsmarket_swap".to_string(),
                    vec![],
                    0,
                    0,
                    300_000_000_000_000,
                ))
            .into();
        Ok(U128(0))
    }

    fn calculate_fee(&self, amount: &U128, params: &SwapParams) -> U128 {
        let bps = match params.venue {
            Venue::Rhea => self.fee_config.buy_fee_bps,
            Venue::Shardsmarket => self.fee_config.sell_fee_bps,
        };
        let fee = (amount.0 * bps as u128) / 10_000;
        U128(fee)
    }

    fn transfer_fee_to_treasury(&self, amount: U128) {
        if amount.0 > 0 {
            near_sdk::promise::Promise::new(self.treasury_id.clone())
                .transfer(amount.0);
        }
    }

    fn transfer_to_caller(&self, amount: U128, token_out: &str) {
        near_sdk::promise::Promise::new(env::predecessor_account_id())
            .function_call(
                "ft_transfer".to_string(),
                serde_json::to_vec(&serde_json::json!({
                    "recipient_id": env::predecessor_account_id(),
                    "amount": amount,
                })).map_err(|e| e.to_string()).unwrap(),
                amount.0,
                0,
                300_000_000_000_000,
            );
    }

    #[private]
    pub fn resolve_rhea_swap(&mut self) -> bool {
        let result: bool = env::promise_results()[0].into();
        result
    }

    #[private]
    pub fn resolve_shardsmarket_swap(&mut self) -> bool {
        let result: bool = env::promise_results()[0].into();
        result
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, accounts};
    use near_sdk::{testing_env, VMContext};

    fn get_context(predecessor: String) -> VMContext {
        VMContextBuilder::new()
            .predecessor_account_id(predecessor)
            .build()
    }

    #[test]
    fn test_new_contract() {
        testing_env!(get_context(accounts::root_account_id()));
        let contract = RacerbotRouter::new(
            "racerbotrouter.near".to_string(),
            "racerbottreasury.near".to_string(),
            100,
            100,
            150,
        );
        assert_eq!(contract.owner_id, "racerbotrouter.near");
        assert_eq!(contract.treasury_id, "racerbottreasury.near");
        assert_eq!(contract.fee_config.buy_fee_bps, 100);
    }

    #[test]
    fn test_fee_calculation() {
        testing_env!(get_context(accounts::root_account_id()));
        let contract = RacerbotRouter::new(
            accounts::root_account_id(),
            accounts::near_account_id(),
            100,
            100,
            150,
        );
        let amount = U128(1000000000000000000000000);
        let params = SwapParams {
            token_in: "token.near".to_string(),
            token_out: "token2.near".to_string(),
            amount_in: U128(1000000000000000000000000),
            min_amount_out: U128(900000000000000000000000),
            venue: Venue::Rhea,
        };
        let fee = contract.calculate_fee(&amount, &params);
        assert_eq!(fee.0, 10000000000000000000000);
    }
}