#![allow(unused_must_use)]

use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult};
use racerbot_position_executor as exec;

fn router() -> AccountId { "racerbotrouter.near".parse().unwrap() }
fn owner() -> AccountId { "racerbot.near".parse().unwrap() }
fn treasury() -> AccountId { "racerbottreasury.near".parse().unwrap() }
fn relayer() -> AccountId { "relayer.racerbot.near".parse().unwrap() }
fn executor() -> AccountId { "abcd1234.racerbotrouter.near".parse().unwrap() }
const OWNER_HASH: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

fn call(predecessor: AccountId, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(router())
        .predecessor_account_id(predecessor)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .build());
}

fn callback(result: PromiseResult) {
    testing_env!(
        VMContextBuilder::new().current_account_id(router()).predecessor_account_id(router()).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

/// Router with executor code set, a relayer allowed and one registered executor
fn setup() -> RacerbotVault {
    call(owner(), 0);
    let mut r = RacerbotVault::new(owner(), treasury(), 150, 150, 250);
    r.set_executor_code("07".repeat(32));
    r.set_relayer(relayer(), true);
    call(relayer(), 3_000_000_000_000_000_000_000);
    let _ = r.create_executor("abcd1234".into(), OWNER_HASH.into());
    r
}

/// A borsh plan exactly as the backend sends it (built from the executor's own types)
fn plan_struct() -> exec::SwapPlan {
    exec::SwapPlan {
        venue: exec::Venue::Intear,
        token: "meme.near".parse().unwrap(),
        hops: vec![exec::Hop {
            pool_id: Some(274),
            dcl_pool_id: Some("meme.near|wrap.near|10000".into()),
            token_in: "near".into(),
            token_out: "meme.near".into(),
            min_amount_out: 5,
        }],
        amount_in: 1_000,
        min_amount_out: 5,
        receiver: Some("gaypad.j1-racing.near".parse().unwrap()),
        deadline_sec: 1_800_000_000,
        correlation_id: "intent_1".into(),
    }
}

fn plan() -> Base64VecU8 {
    Base64VecU8(borsh::to_vec(&plan_struct()).unwrap())
}

// ── Wire compatibility with the executor contract ────────────────────────────

/// The backend (packages/api executorPlan.ts) must produce exactly these bytes for plan_struct()
#[test]
fn plan_borsh_vector() {
    let hex: String = borsh::to_vec(&plan_struct()).unwrap().iter().map(|b| format!("{:02x}", b)).collect();
    assert_eq!(hex, PLAN_VECTOR_HEX);
}

const PLAN_VECTOR_HEX: &str = "02090000006d656d652e6e6561720100000001120100000000000001190000006d656d652e6e6561727c777261702e6e6561727c3130303030040000006e656172090000006d656d652e6e65617205000000000000000000000000000000e80300000000000000000000000000000500000000000000000000000000000001150000006761797061642e6a312d726163696e672e6e65617200d2496b0000000008000000696e74656e745f31";

#[test]
fn buy_args_decode_as_plan_then_fee() {
    let mut args = plan().0;
    args.extend_from_slice(&150u32.to_le_bytes());
    let (p, fee): (exec::SwapPlan, u32) = borsh::from_slice(&args).unwrap();
    assert_eq!(p.correlation_id, "intent_1");
    assert_eq!(fee, 150);
}

#[test]
fn init_args_decode_as_executor_new() {
    let init = borsh::to_vec(&NewArgs { router: router(), owner_hash: vec![9; 32] }).unwrap();
    let (r, h): (AccountId, Vec<u8>) = borsh::from_slice(&init).unwrap();
    assert_eq!(r, router());
    assert_eq!(h, vec![9; 32]);
}

// ── Admin and access ─────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Only owner")]
fn only_owner_sets_code() {
    let mut r = setup();
    call(relayer(), 0);
    r.set_executor_code("01".repeat(32));
}

#[test]
#[should_panic(expected = "Only owner or relayer")]
fn strangers_cannot_create_executors() {
    let mut r = setup();
    call("stranger.near".parse().unwrap(), 3_000_000_000_000_000_000_000);
    r.create_executor("zzzz9999".into(), OWNER_HASH.into());
}

#[test]
fn create_registers_owner_hash() {
    let r = setup();
    assert_eq!(r.executor_owner_hash(executor()), Some(OWNER_HASH.to_string()));
    assert!(r.is_relayer(relayer()));
}

#[test]
#[should_panic(expected = "Executor already exists")]
fn executor_names_are_unique() {
    let mut r = setup();
    call(relayer(), 3_000_000_000_000_000_000_000);
    r.create_executor("abcd1234".into(), OWNER_HASH.into());
}

#[test]
#[should_panic(expected = "Executor name")]
fn executor_name_validated() {
    let mut r = setup();
    call(relayer(), 3_000_000_000_000_000_000_000);
    r.create_executor("Bad.Name".into(), OWNER_HASH.into());
}

#[test]
#[should_panic(expected = "Hash must be 64 hex characters")]
fn owner_hash_validated() {
    let mut r = setup();
    call(relayer(), 3_000_000_000_000_000_000_000);
    r.create_executor("zzzz9999".into(), "abc".into());
}

#[test]
#[should_panic(expected = "Attach NEAR")]
fn creation_needs_deposit() {
    let mut r = setup();
    call(relayer(), 0);
    r.create_executor("zzzz9999".into(), OWNER_HASH.into());
}

#[test]
fn failed_creation_unregisters() {
    let mut r = setup();
    callback(PromiseResult::Failed);
    assert!(!r.on_executor_created(executor()));
    assert_eq!(r.executor_owner_hash(executor()), None);
}

#[test]
#[should_panic(expected = "Only owner or relayer")]
fn removed_relayer_loses_access() {
    let mut r = setup();
    call(owner(), 0);
    r.set_relayer(relayer(), false);
    call(relayer(), 0);
    r.exec_sell(executor(), plan());
}

// ── Trade forwarding ─────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Unknown executor")]
fn trades_only_go_to_registered_executors() {
    let mut r = setup();
    call(relayer(), 0);
    r.exec_buy("other.racerbotrouter.near".parse().unwrap(), plan(), 150);
}

#[test]
#[should_panic(expected = "Buy fee must match fee_config")]
fn buy_fee_must_match_config() {
    let mut r = setup();
    call(relayer(), 0);
    r.exec_buy(executor(), plan(), 100);
}

#[test]
fn exit_fee_accepts_standard_and_large_rates() {
    let mut r = setup();
    call(relayer(), 0);
    let _ = r.exec_prepare_exit(executor(), 150);
    let _ = r.exec_prepare_exit(executor(), 200);
}

#[test]
#[should_panic(expected = "Sell fee must match fee_config")]
fn exit_fee_rejects_other_rates() {
    let mut r = setup();
    call(relayer(), 0);
    r.exec_prepare_exit(executor(), 250);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn pause_stops_executor_trades() {
    let mut r = setup();
    call(owner(), 0);
    r.pause();
    call(relayer(), 0);
    r.exec_sell(executor(), plan());
}

// ── Fees ─────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Only executors pay fees")]
fn fees_only_from_executors() {
    let mut r = setup();
    call("stranger.near".parse().unwrap(), 10);
    r.collect_fee();
}

#[test]
fn fees_accrue_and_sweep() {
    let mut r = setup();
    call(executor(), 15);
    r.collect_fee();
    call(executor(), 5);
    r.collect_fee();
    assert_eq!(r.executor_fees().0, 20);
    call(relayer(), 0);
    let _ = r.sweep_executor_fees();
    assert_eq!(r.executor_fees().0, 0);
}

#[test]
fn failed_sweep_restores_fees() {
    let mut r = setup();
    callback(PromiseResult::Failed);
    assert!(!r.on_fees_swept(U128(20)));
    assert_eq!(r.executor_fees().0, 20);
}

#[test]
fn large_sell_rate_configurable_within_cap() {
    let mut r = setup();
    assert_eq!(r.get_large_sell_fee_bps(), 200);
    call(owner(), 0);
    r.set_large_sell_fee_bps(180);
    assert_eq!(r.get_large_sell_fee_bps(), 180);
}

#[test]
#[should_panic(expected = "Above executor maximum")]
fn large_sell_rate_capped() {
    let mut r = setup();
    call(owner(), 0);
    r.set_large_sell_fee_bps(201);
}

#[test]
fn closed_executor_drops_its_record() {
    let mut r = setup();
    call(executor(), 0);
    r.executor_closed();
    assert!(r.executor_owner_hash(executor()).is_none());
    // Anyone else calling it changes nothing
    call(relayer(), 0);
    r.executor_closed();
}
