/*!
 * RacerBot position executor: one keyless account per confidential position.
 *
 * Deployed once as a NEAR global contract; every executor is a subaccount of the router
 * running this code. An executor holds exactly one position and only ever:
 *   • swaps on a fixed list of venues, building every venue message itself from typed fields,
 *   • pays the RacerBot fee to the router (capped at MAX_FEE_BPS),
 *   • sends its NEAR to a NEAR Intents deposit address or to its owner (salted-hash checked),
 *   • closes itself once every balance it tracked is zero.
 *
 * Because one account belongs to one user, balances are exact: nothing has to be attributed.
 * Arguments are borsh (the router is the only trading caller); this keeps the code small enough
 * to deploy as a global contract, where every byte is paid for.
 */

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise, PromiseError, PromiseOrValue};

/// Concatenate pieces into a String without core::fmt (keeps the global contract small)
macro_rules! cat {
    ($($piece:expr),* $(,)?) => {{
        let mut s = String::new();
        $( Piece::put(&$piece, &mut s); )*
        s
    }};
}

trait Piece {
    fn put(&self, out: &mut String);
}
impl Piece for str {
    fn put(&self, out: &mut String) { out.push_str(self) }
}
impl Piece for String {
    fn put(&self, out: &mut String) { out.push_str(self) }
}
impl Piece for AccountId {
    fn put(&self, out: &mut String) { out.push_str(self.as_str()) }
}
impl Piece for bool {
    fn put(&self, out: &mut String) { out.push_str(if *self { "true" } else { "false" }) }
}
impl Piece for u128 {
    fn put(&self, out: &mut String) {
        let mut digits = [0u8; 39];
        let (mut v, mut i) = (*self, digits.len());
        loop {
            i -= 1;
            digits[i] = b'0' + (v % 10) as u8;
            v /= 10;
            if v == 0 { break; }
        }
        out.push_str(core::str::from_utf8(&digits[i..]).unwrap_or_default());
    }
}
impl Piece for u64 {
    fn put(&self, out: &mut String) { (*self as u128).put(out) }
}
impl<T: Piece + ?Sized> Piece for &T {
    fn put(&self, out: &mut String) { (**self).put(out) }
}

/// A known-valid account id, without the Debug-printing unwrap path
fn account(id: &str) -> AccountId {
    id.parse().unwrap_or_else(|_| env::abort())
}

// ── Venues ────────────────────────────────────────────────────────────────────
const WRAP_NEAR: &str = "wrap.near";
const REF_AMM: &str = "v2.ref-finance.near";
const REF_DCL: &str = "dclv2.ref-labs.near";
const INTEAR_DEX: &str = "dex.intear.near";
const INTEAR_XYK: &str = "slimedragon.near/xyk";
const SHARDSMARKET: &str = "factory.shardsmarket.near";
/// Launchpads that trade through ft_transfer_call with `{"token": <token>}`
const LAUNCHPAD_RECEIVERS: [&str; 2] = ["gaypad.j1-racing.near", "exchange.kelytradevs.near"];
/// Bonding-curve token contracts trade on themselves (buy/sell)
const BONDING_CURVE_SUFFIX: &str = ".nearpumpfun.near";

// ── Limits ────────────────────────────────────────────────────────────────────
/// Highest fee any instruction can charge (the bot's 2% large-sell rate)
pub const MAX_FEE_BPS: u32 = 200;
/// Blocks between the exit and deletion, so late venue payouts land first
pub const CLOSE_DELAY_BLOCKS: u64 = 20;
/// Native NEAR above the reserve that may be left at deletion: covers registration deposits
/// refunded after the exit (an already-registered account gets its storage_deposit back)
const DUST: u128 = 3 * STORAGE_DEPOSIT;
/// Reserve that must stay above the storage stake (registrations are paid from the reserve)
const RESERVE_BUFFER: u128 = 1_000_000_000_000_000_000_000; // 0.001 NEAR
/// After this long without router activity the owner may exit with their salt
pub const OWNER_EXIT_AFTER_NS: u64 = 7 * 24 * 3600 * 1_000_000_000;
/// Default sell fee for the owner's safety exit (the bot's standard rate)
const DEFAULT_SELL_FEE_BPS: u32 = 150;
/// Tokens one executor may track (each failed buy of a new token adds one; the close checks them all)
const MAX_TOKENS: usize = 4;

const STORAGE_DEPOSIT: u128 = 1_250_000_000_000_000_000_000; // 0.00125 NEAR
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

// ── Gas ───────────────────────────────────────────────────────────────────────
const GAS_STORAGE: Gas = Gas::from_tgas(10);
const GAS_WRAP: Gas = Gas::from_tgas(10);
const GAS_SWAP: Gas = Gas::from_tgas(120);
const GAS_VIEW: Gas = Gas::from_tgas(5);
const GAS_FT_XFER: Gas = Gas::from_tgas(15);
const GAS_FEE: Gas = Gas::from_tgas(5);
const GAS_CB_TRADE: Gas = Gas::from_tgas(25);
const GAS_CB_EXIT: Gas = Gas::from_tgas(40);
const GAS_CB_CLOSE: Gas = Gas::from_tgas(80);
const GAS_CB_DELETE: Gas = Gas::from_tgas(20);
const GAS_CB_SMALL: Gas = Gas::from_tgas(10);
const GAS_CB_SWEEP: Gas = Gas::from_tgas(25);

// ── Plan types ────────────────────────────────────────────────────────────────
#[derive(BorshSerialize, BorshDeserialize, Clone, PartialEq, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub enum Venue {
    /// Ref DCL (also Nearlytrade, OneTokenHub, NEARpad, ShoreMarkets, Qlyphs pools)
    Dcl,
    /// Ref v2 / Rhea AMM
    RefAmm,
    /// dex.intear.near
    Intear,
    /// factory.shardsmarket.near (buys)
    Shardsmarket,
    /// *.nearpumpfun.near bonding curves
    BondingCurve,
    /// Gaypad / Kelytra launchpad exchanges (`receiver` names which)
    Launchpad,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Hop {
    pub pool_id: Option<u64>,
    pub dcl_pool_id: Option<String>,
    /// Token entering this hop: "near" stands for wNEAR
    pub token_in: String,
    pub token_out: String,
    pub min_amount_out: u128,
}

/// One trade. Buys spend NEAR for `token`; sells spend `token` for NEAR.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub struct SwapPlan {
    pub venue: Venue,
    pub token: AccountId,
    pub hops: Vec<Hop>,
    pub amount_in: u128,
    pub min_amount_out: u128,
    /// Launchpad exchange account (Venue::Launchpad only)
    pub receiver: Option<AccountId>,
    /// Bonding-curve deadline, seconds since epoch
    pub deadline_sec: u64,
    /// Backend reference for receipts (letters, digits, '_' and '-' only)
    pub correlation_id: String,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, PartialEq, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub enum Status {
    /// Funded, no position yet
    Ready,
    /// Holds a position
    Open,
    /// Fee paid and NEAR measured; waiting to send it out
    Exiting,
    /// NEAR sent out; may be deleted after CLOSE_DELAY_BLOCKS
    Exited,
}

/// How the venue reports a buy's result
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, PartialEq, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub enum ResultKind {
    /// ft_transfer_call: the promise returns the amount the venue used
    FtUsed,
    /// call with attached NEAR: success spent it all, failure refunds it
    Attached,
}

#[near(contract_state)]
pub struct PositionExecutor {
    router: AccountId,
    owner_hash: Vec<u8>,
    status: Status,
    /// Tokens this executor registered with (checked and unregistered at close)
    tokens: Vec<AccountId>,
    wnear_registered: bool,
    /// RacerBot's NEAR in this account (the creation deposit, less registrations it paid for).
    /// Only NEAR above it belongs to the user.
    reserve: u128,
    /// NEAR value left after the buy (native + wNEAR); proceeds above it pay the sell fee
    value_after_buy: u128,
    /// NEAR measured for the exit, already net of fee
    exit_amount: u128,
    exited_at_block: u64,
    last_router_call_ns: u64,
}

impl Default for PositionExecutor {
    fn default() -> Self {
        env::panic_str("PositionExecutor: call new()");
    }
}

#[near]
impl PositionExecutor {
    #[init]
    pub fn new(#[serializer(borsh)] router: AccountId, #[serializer(borsh)] owner_hash: Vec<u8>) -> Self {
        require!(!env::state_exists(), "Already initialized");
        require!(env::predecessor_account_id() == router, "Only the router creates executors");
        require!(owner_hash.len() == 32, "owner_hash must be 32 bytes");
        // Everything here at creation is RacerBot's deposit; the user's funds arrive afterwards
        let reserve = env::account_balance().as_yoctonear();
        Self {
            router,
            owner_hash,
            status: Status::Ready,
            tokens: Vec::new(),
            wnear_registered: false,
            reserve,
            value_after_buy: 0,
            exit_amount: 0,
            exited_at_block: 0,
            last_router_call_ns: env::block_timestamp(),
        }
    }

    // ═══════════════════════════ TRADING ═════════════════════════════════════

    /// Buy `plan.token` with native NEAR. The fee (fee_bps of amount_in) is paid only for what the venue used.
    pub fn buy(&mut self, #[serializer(borsh)] plan: SwapPlan, #[serializer(borsh)] fee_bps: u32) -> Promise {
        self.assert_router();
        require!(self.status == Status::Ready, "Executor already holds a position");
        require!(fee_bps <= MAX_FEE_BPS, "Fee above maximum");
        let value_before = self.native_available();
        // Spend what is actually here when funding arrived a hair short (e.g. a bridge fee), never more
        require!(value_before >= plan.amount_in - plan.amount_in / 100, "Not enough NEAR in executor");
        let amount_in = plan.amount_in.min(value_before);
        let fee = amount_in * fee_bps as u128 / 10_000;
        let swap_amount = amount_in - fee;
        require!(swap_amount > 0, "Amount too small after fee");

        let mut registration_cost = 0u128;
        let mut setup: Option<Promise> = None;
        if !self.tokens.contains(&plan.token) {
            require!(self.tokens.len() < MAX_TOKENS, "Too many tokens: exit this executor");
            setup = Some(Self::register_with(&plan.token));
            self.tokens.push(plan.token.clone());
            registration_cost += STORAGE_DEPOSIT;
        }
        let wnear_before = self.wnear_registered;
        let (swap, kind) = self.build_buy(&plan, swap_amount, &mut registration_cost);
        // If the swap receipt rolls back, so does a wNEAR registration inside it
        let wnear_in_swap = !wnear_before && self.wnear_registered;
        self.spend_reserve(registration_cost);
        // A queued registration joins the swap, which makes the swap's result index 1
        let result_index: u64 = if setup.is_some() { 1 } else { 0 };
        let joined = match setup {
            Some(reg) => reg.and(swap),
            None => swap,
        };
        self.status = Status::Open;
        emit("buy_submitted", &cat!(r#"{"correlation_id":""#, clean(&plan.correlation_id), r#"","token":""#, plan.token, r#"","amount_in":""#, amount_in, r#"","fee_reserved":""#, fee, r#""}"#));
        joined.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CB_TRADE)
                .on_buy(plan.correlation_id, amount_in, swap_amount, fee_bps, value_before, kind, result_index, wnear_in_swap),
        )
    }

    /// Sell `plan.amount_in` of `plan.token` for NEAR. No fee here: the sell fee is charged on proceeds at exit.
    pub fn sell(&mut self, #[serializer(borsh)] plan: SwapPlan) -> Promise {
        self.assert_router();
        require!(self.status == Status::Open, "No open position");
        let mut setup: Option<Promise> = None;
        if !self.wnear_registered && plan.venue != Venue::BondingCurve && plan.venue != Venue::Intear {
            setup = Some(Self::register_with(&wnear()));
            self.wnear_registered = true;
            self.spend_reserve(STORAGE_DEPOSIT);
        }
        let swap = Self::build_sell(&plan);
        let result_index: u64 = if setup.is_some() { 1 } else { 0 };
        let joined = match setup {
            Some(reg) => reg.and(swap),
            None => swap,
        };
        emit("sell_submitted", &cat!(r#"{"correlation_id":""#, clean(&plan.correlation_id), r#"","token":""#, plan.token, r#"","amount_in":""#, plan.amount_in, r#""}"#));
        joined.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CB_SMALL)
                .on_sell(plan.correlation_id, plan.amount_in, result_index),
        )
    }

    // ═══════════════════════════ EXIT ════════════════════════════════════════

    /// Step 1 of an exit: unwrap any wNEAR, measure the NEAR, pay the sell fee on proceeds.
    /// Leaves `exit_amount` ready to send (net of fee and of the registrations an Intents exit needs).
    pub fn prepare_exit(&mut self, #[serializer(borsh)] fee_bps: u32) -> Promise {
        self.assert_router();
        require!(fee_bps <= MAX_FEE_BPS, "Fee above maximum");
        self.start_prepare_exit(fee_bps)
    }

    /// Step 2a: send exactly `amount` of the measured NEAR, as wNEAR, to a NEAR Intents deposit address.
    pub fn exit_to_intents(&mut self, #[serializer(borsh)] deposit_address: AccountId, #[serializer(borsh)] amount: u128) -> Promise {
        self.assert_router();
        require!(self.status == Status::Exiting, "Call prepare_exit first");
        require!(amount > 0 && amount <= self.exit_amount, "Amount above the measured exit amount");
        self.exit_amount -= amount;
        let mut p = Promise::new(wnear());
        let wnear_in_batch = !self.wnear_registered;
        if wnear_in_batch {
            p = p.function_call("storage_deposit".to_string(), self_registration_args(), NearToken::from_yoctonear(STORAGE_DEPOSIT), GAS_STORAGE);
            self.wnear_registered = true;
            self.spend_reserve(STORAGE_DEPOSIT);
        }
        // The deposit address's registration is RacerBot's cost too
        self.spend_reserve(STORAGE_DEPOSIT);
        let registrations = if wnear_in_batch { 2 * STORAGE_DEPOSIT } else { STORAGE_DEPOSIT };
        p.function_call("storage_deposit".to_string(),
                cat!(r#"{"account_id":""#, deposit_address, r#"","registration_only":true}"#).into_bytes(),
                NearToken::from_yoctonear(STORAGE_DEPOSIT), GAS_STORAGE)
            .function_call("near_deposit".to_string(), b"{}".to_vec(), NearToken::from_yoctonear(amount), GAS_WRAP)
            .function_call("ft_transfer".to_string(),
                cat!(r#"{"receiver_id":""#, deposit_address, r#"","amount":""#, amount, r#""}"#).into_bytes(),
                ONE_YOCTO, GAS_FT_XFER)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB_SMALL).on_exit_sent(deposit_address, amount, registrations, wnear_in_batch))
    }

    /// Step 2b: send the measured NEAR to the owner (fast withdraw, publicly linked).
    pub fn exit_to_owner(&mut self, #[serializer(borsh)] to: AccountId, #[serializer(borsh)] salt: String) -> Promise {
        self.assert_router();
        self.assert_owner_address(&to, &salt);
        require!(self.status == Status::Exiting, "Call prepare_exit first");
        self.exit_to_owner_unchecked(to)
    }

    /// Send a token's whole balance to the owner (withdraw a position as tokens; publicly linked).
    pub fn send_token_to_owner(&mut self, #[serializer(borsh)] token: AccountId, #[serializer(borsh)] to: AccountId,
                               #[serializer(borsh)] salt: String) -> Promise {
        self.assert_router();
        self.assert_owner_address(&to, &salt);
        Self::sweep_token(token, to)
    }

    /// Anyone holding the owner's salt may move a token (not wNEAR) to the owner: recovers late payouts.
    pub fn sweep(&mut self, #[serializer(borsh)] token: AccountId, #[serializer(borsh)] to: AccountId,
                 #[serializer(borsh)] salt: String) -> Promise {
        self.assert_owner_address(&to, &salt);
        require!(token.as_str() != WRAP_NEAR, "wNEAR leaves through an exit");
        Self::sweep_token(token, to)
    }

    /// Safety exit when RacerBot is unavailable: after OWNER_EXIT_AFTER_NS without router activity,
    /// anyone holding the salt can measure (first call) and then send (second call) the NEAR to the owner.
    pub fn owner_exit(&mut self, #[serializer(borsh)] to: AccountId, #[serializer(borsh)] salt: String) -> Promise {
        self.assert_owner_address(&to, &salt);
        require!(env::block_timestamp() >= self.last_router_call_ns + OWNER_EXIT_AFTER_NS, "Router still active");
        if self.status == Status::Exiting {
            return self.exit_to_owner_unchecked(to);
        }
        self.start_prepare_exit(DEFAULT_SELL_FEE_BPS)
    }

    /// Delete the executor once it has exited and every tracked balance is zero.
    /// Callable by anyone after CLOSE_DELAY_BLOCKS; what is left (storage reserve) returns to the router.
    pub fn finish_close(&mut self) -> Promise {
        require!(self.status == Status::Exited, "Not exited");
        require!(env::block_height() >= self.exited_at_block + CLOSE_DELAY_BLOCKS, "Close delay not over");
        let mut check = Self::balance_of(&wnear());
        for t in &self.tokens {
            check = check.and(Self::balance_of(t));
        }
        check.then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB_CLOSE).on_close_checked())
    }

    // ═══════════════════════════ CALLBACKS ═══════════════════════════════════

    #[private]
    pub fn on_buy(&mut self, #[serializer(borsh)] correlation_id: String, #[serializer(borsh)] amount_in: u128,
                  #[serializer(borsh)] swap_amount: u128, #[serializer(borsh)] fee_bps: u32,
                  #[serializer(borsh)] value_before: u128, #[serializer(borsh)] kind: ResultKind, #[serializer(borsh)] result_index: u64,
                  #[serializer(borsh)] wnear_in_swap: bool) {
        let swap_failed = failed(result_index);
        let used = match kind {
            ResultKind::FtUsed => read_u128(result_index).unwrap_or(0).min(swap_amount),
            ResultKind::Attached => if swap_failed { 0 } else { swap_amount },
        };
        if used == 0 {
            // Nothing bought: the input is back (native, or as wNEAR from a refunded ft_transfer_call)
            self.status = Status::Ready;
            if result_index == 1 && failed(0) {
                // The token's registration was refunded: stop tracking it, or the close check could never pass
                self.tokens.pop();
                self.reserve += STORAGE_DEPOSIT;
            }
            if swap_failed && wnear_in_swap {
                // The wrap-and-send receipt rolled back, its wNEAR registration with it (the deposit is refunded)
                self.wnear_registered = false;
                self.reserve += STORAGE_DEPOSIT;
            }
            if kind == ResultKind::FtUsed && !swap_failed {
                Promise::new(wnear())
                    .function_call("near_withdraw".to_string(), cat!(r#"{"amount":""#, swap_amount, r#""}"#).into_bytes(), ONE_YOCTO, GAS_WRAP)
                    .detach();
            }
            emit("buy_failed", &cat!(r#"{"correlation_id":""#, clean(&correlation_id), r#"","amount_in":""#, amount_in, r#""}"#));
            return;
        }
        // fee = amount_in·bps/10000 and swap = amount_in − fee, so the fee on what was used is used·bps/(10000−bps)
        let fee_paid = (amount_in - swap_amount).min(used * fee_bps as u128 / (10_000 - fee_bps as u128));
        self.value_after_buy = value_before.saturating_sub(used + fee_paid);
        if fee_paid > 0 {
            self.pay_fee(fee_paid);
        }
        emit("bought", &cat!(r#"{"correlation_id":""#, clean(&correlation_id), r#"","used":""#, used, r#"","fee":""#, fee_paid, r#"","value_after_buy":""#, self.value_after_buy, r#""}"#));
    }

    #[private]
    pub fn on_sell(&mut self, #[serializer(borsh)] correlation_id: String, #[serializer(borsh)] amount_in: u128,
                   #[serializer(borsh)] result_index: u64) {
        let ok = !failed(result_index);
        // ft_transfer_call returns the amount used; a refunded sell leaves the tokens here
        let used = read_u128(result_index).unwrap_or(if ok { amount_in } else { 0 });
        emit(if used > 0 { "sold" } else { "sell_failed" }, &cat!(r#"{"correlation_id":""#, clean(&correlation_id), r#"","amount_in":""#, amount_in, r#"","used":""#, used, r#""}"#));
    }

    #[private]
    pub fn on_exit_balance(&mut self, #[serializer(borsh)] fee_bps: u32) -> PromiseOrValue<()> {
        let wnear_balance = read_u128(0).unwrap_or(0);
        if wnear_balance > 0 {
            return PromiseOrValue::Promise(
                Promise::new(wnear())
                    .function_call("near_withdraw".to_string(), cat!(r#"{"amount":""#, wnear_balance, r#""}"#).into_bytes(), ONE_YOCTO, GAS_WRAP)
                    .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB_SMALL).on_exit_measured(fee_bps)),
            );
        }
        self.on_exit_measured(fee_bps);
        PromiseOrValue::Value(())
    }

    #[private]
    pub fn on_exit_measured(&mut self, #[serializer(borsh)] fee_bps: u32) {
        let available = self.native_available();
        let proceeds = if self.status == Status::Open { available.saturating_sub(self.value_after_buy) } else { 0 };
        let fee = proceeds * fee_bps as u128 / 10_000;
        if fee > 0 {
            self.pay_fee(fee);
        }
        self.exit_amount = available.saturating_sub(fee);
        if self.exit_amount == 0 {
            // Nothing to send (an unused or failed executor): ready to close
            self.status = Status::Exited;
            self.exited_at_block = env::block_height();
        } else {
            self.status = Status::Exiting;
        }
        emit("exit_ready", &cat!(r#"{"amount":""#, self.exit_amount, r#"","proceeds":""#, proceeds, r#"","fee":""#, fee, r#""}"#));
    }

    #[private]
    pub fn on_exit_sent(&mut self, #[serializer(borsh)] to: AccountId, #[serializer(borsh)] amount: u128,
                        #[serializer(borsh)] registrations: u128, #[serializer(borsh)] wnear_in_batch: bool) {
        if !failed(0) {
            if self.exit_amount > 0 {
                // Part of the measured NEAR is still here (a rounded return sends the rest later)
                emit("exit_partial", &cat!(r#"{"to":""#, to, r#"","amount":""#, amount, r#"","remaining":""#, self.exit_amount, r#""}"#));
                return;
            }
            self.status = Status::Exited;
            self.exited_at_block = env::block_height();
            emit("exited", &cat!(r#"{"to":""#, to, r#"","amount":""#, amount, r#""}"#));
        } else {
            // The whole receipt rolled back: the NEAR and the registration deposits are back here, and
            // the registrations never happened. prepare_exit measures again (no second fee).
            self.status = Status::Exiting;
            self.exit_amount = 0;
            self.reserve += registrations;
            if wnear_in_batch {
                self.wnear_registered = false;
            }
            emit("exit_failed", &cat!(r#"{"to":""#, to, r#"","amount":""#, amount, r#""}"#));
        }
    }

    #[private]
    pub fn on_close_checked(&mut self) -> Promise {
        let count = 1 + self.tokens.len() as u64;
        for i in 0..count {
            require!(read_u128(i) == Some(0), "A tracked balance is not zero: sweep or exit first");
        }
        require!(self.native_available() <= DUST, "NEAR left: exit first");
        let mut registered = self.tokens.clone();
        if self.wnear_registered {
            registered.push(wnear());
        }
        let delete = Self::ext(env::current_account_id()).with_static_gas(GAS_CB_DELETE).on_close_delete(registered.len() as u64);
        let mut unregister: Option<Promise> = None;
        for t in registered {
            // Never force: a non-zero balance makes this fail instead of burning tokens
            let p = Promise::new(t).function_call("storage_unregister".to_string(), b"{}".to_vec(), ONE_YOCTO, GAS_STORAGE);
            unregister = Some(match unregister { Some(u) => u.and(p), None => p });
        }
        match unregister {
            Some(u) => u.then(delete),
            None => delete,
        }
    }

    #[private]
    pub fn on_close_delete(&mut self, #[serializer(borsh)] unregistered: u64) -> PromiseOrValue<()> {
        // A failed unregister means a balance arrived after the check: keep the account so it can be
        // swept (a `false` result, not registered, is fine)
        for i in 0..unregistered {
            if failed(i) {
                emit("close_blocked", "{}");
                return PromiseOrValue::Value(());
            }
        }
        emit("closed", &cat!(r#"{"beneficiary":""#, self.router, r#""}"#));
        // Let the router drop its record of this executor (frees the router's storage)
        Promise::new(self.router.clone())
            .function_call("executor_closed".to_string(), b"{}".to_vec(), NearToken::from_yoctonear(0), GAS_FEE)
            .detach();
        PromiseOrValue::Promise(Promise::new(env::current_account_id()).delete_account(self.router.clone()))
    }

    #[private]
    pub fn on_sweep_balance(&mut self, #[serializer(borsh)] token: AccountId, #[serializer(borsh)] to: AccountId) -> PromiseOrValue<()> {
        let bal = read_u128(0).unwrap_or(0);
        if bal == 0 {
            return PromiseOrValue::Value(());
        }
        emit("swept", &cat!(r#"{"token":""#, token, r#"","amount":""#, bal, r#""}"#));
        PromiseOrValue::Promise(Promise::new(token).function_call(
            "ft_transfer".to_string(),
            cat!(r#"{"receiver_id":""#, to, r#"","amount":""#, bal, r#""}"#).into_bytes(),
            ONE_YOCTO,
            GAS_FT_XFER,
        ))
    }

    // ═══════════════════════════ VIEWS ═══════════════════════════════════════

    /// JSON view of the executor's state
    pub fn get_state(&self) {
        let status = match self.status {
            Status::Ready => "Ready",
            Status::Open => "Open",
            Status::Exiting => "Exiting",
            Status::Exited => "Exited",
        };
        let tokens: Vec<String> = self.tokens.iter().map(|t| cat!(r#"""#, t, r#"""#)).collect();
        env::value_return(cat!(r#"{"router":""#, self.router, r#"","status":""#, status, r#"","tokens":["#, tokens.join(","), r#"],"wnear_registered":"#, self.wnear_registered, r#","value_after_buy":""#, self.value_after_buy, r#"","exit_amount":""#, self.exit_amount, r#"","native_available":""#, self.native_available(), r#"","reserve":""#, self.reserve, r#"","exited_at_block":"#, self.exited_at_block, "}").as_bytes());
    }
}

// ═══════════════════════════ INTERNALS ═══════════════════════════════════════

impl PositionExecutor {
    fn assert_router(&mut self) {
        require!(env::predecessor_account_id() == self.router, "Only the router");
        self.last_router_call_ns = env::block_timestamp();
    }

    fn assert_owner_address(&self, to: &AccountId, salt: &str) {
        let mut preimage = salt.as_bytes().to_vec();
        preimage.extend_from_slice(to.as_bytes());
        require!(env::sha256(&preimage) == self.owner_hash, "Not the owner's address");
    }

    /// The user's native NEAR: everything above RacerBot's reserve
    fn native_available(&self) -> u128 {
        env::account_balance().as_yoctonear().saturating_sub(self.reserve)
    }

    /// Pay a registration from RacerBot's reserve, which must stay above the storage stake
    fn spend_reserve(&mut self, amount: u128) {
        self.reserve = self.reserve.saturating_sub(amount);
        let storage = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
        require!(self.reserve >= storage + RESERVE_BUFFER, "Executor reserve too low for registrations");
    }

    /// Also runs after an exit, when a refunded NEAR Intents deposit brought NEAR back (no second fee)
    fn start_prepare_exit(&mut self, fee_bps: u32) -> Promise {
        Self::balance_of(&wnear())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB_EXIT).on_exit_balance(fee_bps))
    }

    fn exit_to_owner_unchecked(&mut self, to: AccountId) -> Promise {
        let amount = self.exit_amount;
        self.exit_amount = 0;
        Promise::new(to.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB_SMALL).on_exit_sent(to, amount, 0, false))
    }

    fn pay_fee(&self, amount: u128) {
        Promise::new(self.router.clone())
            .function_call("collect_fee".to_string(), b"{}".to_vec(), NearToken::from_yoctonear(amount), GAS_FEE)
            .detach();
    }

    fn register_with(token: &AccountId) -> Promise {
        Promise::new(token.clone()).function_call(
            "storage_deposit".to_string(),
            self_registration_args(),
            NearToken::from_yoctonear(STORAGE_DEPOSIT),
            GAS_STORAGE,
        )
    }

    fn balance_of(token: &AccountId) -> Promise {
        Promise::new(token.clone()).function_call(
            "ft_balance_of".to_string(),
            cat!(r#"{"account_id":""#, env::current_account_id(), r#""}"#).into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_VIEW,
        )
    }

    fn sweep_token(token: AccountId, to: AccountId) -> Promise {
        Self::balance_of(&token)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB_SWEEP).on_sweep_balance(token, to))
    }

    /// The venue call for a buy, and how its result is reported
    fn build_buy(&mut self, plan: &SwapPlan, amount: u128, registration_cost: &mut u128) -> (Promise, ResultKind) {
        match plan.venue {
            Venue::Dcl | Venue::RefAmm | Venue::Launchpad => {
                let (receiver, msg) = match plan.venue {
                    Venue::Dcl => (REF_DCL.to_string(), dcl_msg(plan)),
                    Venue::RefAmm => (REF_AMM.to_string(), ref_msg(plan, amount)),
                    _ => (launchpad_receiver(plan), launchpad_msg(plan)),
                };
                let mut p = Promise::new(wnear());
                if !self.wnear_registered {
                    p = p.function_call("storage_deposit".to_string(), self_registration_args(),
                        NearToken::from_yoctonear(STORAGE_DEPOSIT), GAS_STORAGE);
                    self.wnear_registered = true;
                    *registration_cost += STORAGE_DEPOSIT;
                }
                // One receipt: wrap then send; its result is ft_transfer_call's used amount
                let p = p
                    .function_call("near_deposit".to_string(), b"{}".to_vec(), NearToken::from_yoctonear(amount), GAS_WRAP)
                    .function_call("ft_transfer_call".to_string(), ft_call_args(&receiver, amount, &msg), ONE_YOCTO, GAS_SWAP);
                (p, ResultKind::FtUsed)
            }
            Venue::Intear => {
                let p = Promise::new(account(INTEAR_DEX)).function_call(
                    "deposit_near".to_string(),
                    cat!(r#"{"operations":"#, intear_ops(plan, amount, true), "}").into_bytes(),
                    NearToken::from_yoctonear(amount), GAS_SWAP);
                (p, ResultKind::Attached)
            }
            Venue::Shardsmarket => {
                let p = Promise::new(account(SHARDSMARKET)).function_call(
                    "buy".to_string(),
                    cat!(r#"{"token_id":""#, plan.token, r#"","min_token_out":""#, plan.min_amount_out, r#"","referrer_id":null}"#).into_bytes(),
                    NearToken::from_yoctonear(amount), GAS_SWAP);
                (p, ResultKind::Attached)
            }
            Venue::BondingCurve => {
                require!(plan.token.as_str().ends_with(BONDING_CURVE_SUFFIX), "Bonding curve not allowed");
                let p = Promise::new(plan.token.clone()).function_call(
                    "buy".to_string(),
                    cat!(r#"{"min_tokens_out":""#, plan.min_amount_out, r#"","deadline_sec":"#, plan.deadline_sec, "}").into_bytes(),
                    NearToken::from_yoctonear(amount), GAS_SWAP);
                (p, ResultKind::Attached)
            }
        }
    }

    /// The venue call for a sell
    fn build_sell(plan: &SwapPlan) -> Promise {
        let ft_call = |receiver: &str, msg: String| {
            Promise::new(plan.token.clone()).function_call(
                "ft_transfer_call".to_string(), ft_call_args(receiver, plan.amount_in, &msg), ONE_YOCTO, GAS_SWAP)
        };
        match plan.venue {
            Venue::Dcl => ft_call(REF_DCL, dcl_msg(plan)),
            Venue::RefAmm => ft_call(REF_AMM, ref_msg(plan, plan.amount_in)),
            Venue::Intear => ft_call(INTEAR_DEX, intear_ops(plan, plan.amount_in, false)),
            Venue::Launchpad => ft_call(&launchpad_receiver(plan), launchpad_msg(plan)),
            Venue::BondingCurve => {
                require!(plan.token.as_str().ends_with(BONDING_CURVE_SUFFIX), "Bonding curve not allowed");
                Promise::new(plan.token.clone()).function_call(
                    "sell".to_string(),
                    cat!(r#"{"tokens_in":""#, plan.amount_in, r#"","min_near_out":""#, plan.min_amount_out, r#"","deadline_sec":"#, plan.deadline_sec, "}").into_bytes(),
                    ONE_YOCTO, GAS_SWAP)
            }
            Venue::Shardsmarket => env::panic_str("Shardsmarket sells go through its pool venue"),
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn wnear() -> AccountId {
    account(WRAP_NEAR)
}

fn emit(event: &str, data: &str) {
    env::log_str(&cat!(r#"EVENT_JSON:{"standard":"racerbot-executor","version":"1.0.0","event":""#, event, r#"","data":"#, data, "}"));
}

/// Keep only characters that are safe inside a JSON string without escaping
fn clean(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').take(64).collect()
}

/// Whether a promise failed. A result too long to read still succeeded.
fn failed(index: u64) -> bool {
    matches!(env::promise_result_checked(index, 0), Err(PromiseError::Failed))
}

/// Parse a JSON U128 result: a quoted decimal string
fn read_u128(index: u64) -> Option<u128> {
    let bytes = env::promise_result_checked(index, 128).ok()?;
    let s = core::str::from_utf8(&bytes).ok()?.trim();
    s.strip_prefix('"')?.strip_suffix('"')?.parse().ok()
}

fn self_registration_args() -> Vec<u8> {
    cat!(r#"{"account_id":""#, env::current_account_id(), r#"","registration_only":true}"#).into_bytes()
}

fn ft_call_args(receiver: &str, amount: u128, msg: &str) -> Vec<u8> {
    cat!(r#"{"receiver_id":""#, receiver, r#"","amount":""#, amount, r#"","msg":""#, escape(msg), r#""}"#).into_bytes()
}

/// Escape a JSON message we built ourselves (only quotes need escaping)
fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Pool ids and token names come from the backend: allow only the characters they use
fn safe_id(s: &str) -> &str {
    require!(!s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-|#".contains(c)), "Bad identifier");
    s
}

fn near_alias(token: &str) -> &str {
    if token == "near" { WRAP_NEAR } else { safe_id(token) }
}

/// DCL swap; sells name wNEAR as output with skip_unwrap_near so it arrives in the same chain
fn dcl_msg(plan: &SwapPlan) -> String {
    let pools: Vec<String> = plan.hops.iter()
        .map(|h| cat!(r#"""#, safe_id(h.dcl_pool_id.as_deref().unwrap_or_else(|| env::panic_str("dcl_pool_id required"))), r#"""#))
        .collect();
    let output = plan.hops.last().map(|h| near_alias(&h.token_out)).unwrap_or_else(|| env::panic_str("No hops"));
    cat!(r#"{"Swap":{"pool_ids":["#, pools.join(","), r#"],"output_token":""#, output, r#"","min_output_amount":""#, plan.min_amount_out, r#"","skip_unwrap_near":true}}"#)
}

fn ref_msg(plan: &SwapPlan, amount: u128) -> String {
    let actions: Vec<String> = plan.hops.iter().enumerate().map(|(i, h)| cat!(r#"{"pool_id":"#, h.pool_id.unwrap_or_else(|| env::panic_str("pool_id required")), r#","token_in":""#, near_alias(&h.token_in), r#"","amount_in":""#, if i == 0 { amount } else { 0 }, r#"","token_out":""#, near_alias(&h.token_out), r#"","min_amount_out":""#, h.min_amount_out, r#""}"#)).collect();
    cat!(r#"{"force":0,"actions":["#, actions.join(","), r#"],"referral_id":null}"#)
}

/// Intear operations: one SwapSimple per hop, then a Withdraw of the output back to this executor
fn intear_ops(plan: &SwapPlan, amount: u128, is_buy: bool) -> String {
    let asset = |t: &str| if t == "near" { "near".to_string() } else { cat!("nep141:", safe_id(t)) };
    let swaps: Vec<String> = plan.hops.iter().enumerate().map(|(i, h)| {
        let pool = h.pool_id.unwrap_or(0) as u32;
        let amount_json = if i == 0 {
            cat!(r#"{"Amount":{"ExactIn":""#, amount, r#""}}"#)
        } else {
            r#""OutputOfLastIn""#.to_string()
        };
        let constraint = if i + 1 == plan.hops.len() { cat!(r#"""#, plan.min_amount_out, r#"""#) } else { "null".to_string() };
        cat!(r#"{"SwapSimple":{"dex_id":""#, INTEAR_XYK, r#"","asset_in":""#, asset(&h.token_in), r#"","asset_out":""#, asset(&h.token_out), r#"","amount":"#, amount_json, r#","constraint":"#, constraint, r#","message":""#, base64_4(pool.to_le_bytes()), r#""}}"#)
    }).collect();
    let out = if is_buy { asset(plan.token.as_str()) } else { "near".to_string() };
    cat!(r#"{"referrer":"dex-aggregator.intear.near","operations":["#, swaps.join(","), r#",{"Withdraw":{"asset_id":""#, out, r#"","amount":{"Full":{"at_least":""#, plan.min_amount_out, r#""}},"to":null,"rescue_address":null}}]}"#)
}

fn launchpad_receiver(plan: &SwapPlan) -> String {
    let receiver = plan.receiver.as_ref().unwrap_or_else(|| env::panic_str("receiver required"));
    require!(LAUNCHPAD_RECEIVERS.contains(&receiver.as_str()), "Receiver not allowed");
    receiver.to_string()
}

fn launchpad_msg(plan: &SwapPlan) -> String {
    cat!(r#"{"token":""#, plan.token, r#""}"#)
}

/// Base64 of a 4-byte little-endian pool id (Intear's xyk message)
fn base64_4(b: [u8; 4]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
    let m = (b[3] as u32) << 16;
    let mut s = String::with_capacity(8);
    for shift in [18, 12, 6, 0] {
        s.push(T[((n >> shift) & 63) as usize] as char);
    }
    s.push(T[((m >> 18) & 63) as usize] as char);
    s.push(T[((m >> 12) & 63) as usize] as char);
    s.push_str("==");
    s
}

#[cfg(test)]
mod tests;
