#![allow(unused_must_use)]

use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// RacerBot's creation deposit (becomes the executor's reserve)
const CREATION: u128 = 12_000_000_000_000_000_000_000; // 0.012 NEAR

fn controller() -> AccountId { "racerbot.near".parse().unwrap() }
fn exec_id() -> AccountId { "x7k2.racerbot.near".parse().unwrap() }
fn owner_addr() -> AccountId { "lunar-nexus-9768.racerbot.near".parse().unwrap() }
fn meme() -> AccountId { "meme.near".parse().unwrap() }
const SALT: &str = "s3cr3t-salt";

fn owner_hash() -> Vec<u8> {
    let mut pre = SALT.as_bytes().to_vec();
    pre.extend_from_slice(owner_addr().as_bytes());
    env::sha256(&pre)
}

fn ctx(predecessor: AccountId, balance: u128) -> VMContextBuilder {
    let mut c = VMContextBuilder::new();
    c.current_account_id(exec_id())
        .predecessor_account_id(predecessor)
        .account_balance(NearToken::from_yoctonear(balance))
        .block_height(1_000)
        .storage_usage(600)
        .block_timestamp(1_000_000_000);
    c
}

fn set(predecessor: AccountId, balance: u128) {
    testing_env!(ctx(predecessor, balance).build());
}

fn callback(balance: u128, results: Vec<PromiseResult>) {
    testing_env!(
        ctx(exec_id(), balance).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

fn u128_result(v: u128) -> PromiseResult {
    PromiseResult::Successful(format!("\"{}\"", v).into_bytes())
}

/// A created executor that the user has funded with `funded` NEAR
fn funded(funded: u128) -> PositionExecutor {
    set(controller(), CREATION);
    let e = PositionExecutor::new(controller(), owner_hash());
    set(controller(), CREATION + funded);
    e
}

fn setup() -> PositionExecutor {
    funded(2 * NEAR)
}

fn plan(venue: Venue, buy: bool) -> SwapPlan {
    let (tin, tout) = if buy { ("near", "meme.near") } else { ("meme.near", "near") };
    SwapPlan {
        venue,
        token: meme(),
        hops: vec![Hop {
            pool_id: Some(274),
            dcl_pool_id: Some("meme.near|wrap.near|10000".into()),
            token_in: tin.into(),
            token_out: tout.into(),
            min_amount_out: 5,
        }],
        amount_in: NEAR,
        min_amount_out: 5,
        receiver: None,
        deadline_sec: 1_800_000_000,
        correlation_id: "c1".into(),
    }
}


// ── Creation and access ──────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Only the controller creates executors")]
fn only_controller_creates() {
    set(owner_addr(), NEAR);
    PositionExecutor::new(controller(), owner_hash());
}

#[test]
#[should_panic(expected = "owner_hash must be 32 bytes")]
fn owner_hash_length_checked() {
    set(controller(), NEAR);
    PositionExecutor::new(controller(), vec![1, 2, 3]);
}

#[test]
#[should_panic(expected = "Only the controller")]
fn buy_rejects_non_controller() {
    let mut e = setup();
    set(owner_addr(), 2 * NEAR);
    e.buy(plan(Venue::Dcl, true), 150);
}

#[test]
#[should_panic(expected = "Fee above maximum")]
fn buy_caps_fee() {
    let mut e = setup();
    e.buy(plan(Venue::Dcl, true), MAX_FEE_BPS + 1);
}

#[test]
#[should_panic(expected = "Not enough NEAR in executor")]
fn buy_needs_funds() {
    let mut e = funded(NEAR / 2);
    e.buy(plan(Venue::Dcl, true), 150);
}

#[test]
fn buy_spends_available_when_slightly_short() {
    // Funded 0.995 NEAR for a 1 NEAR buy (0.5% short): spends the 0.995
    let mut e = funded(NEAR - NEAR / 200);
    e.buy(plan(Venue::Dcl, true), 150);
    assert_eq!(e.status, Status::Open);
}

#[test]
fn buy_registers_token_and_opens() {
    let mut e = setup();
    e.buy(plan(Venue::Dcl, true), 150);
    assert_eq!(e.status, Status::Open);
    assert_eq!(e.tokens, vec![meme()]);
    assert!(e.wnear_registered);
    // Both registrations came out of RacerBot's reserve, not the user's NEAR
    assert_eq!(e.reserve, CREATION - 2 * STORAGE_DEPOSIT);
}

#[test]
fn creation_deposit_is_not_the_users() {
    let e = funded(NEAR);
    assert_eq!(e.reserve, CREATION);
    assert_eq!(e.native_available(), NEAR);
}

#[test]
#[should_panic(expected = "Executor reserve too low for registrations")]
fn registrations_need_enough_reserve() {
    set(controller(), 7_000_000_000_000_000_000_000); // 0.007 NEAR: storage stake + buffer, nothing for registrations
    let mut e = PositionExecutor::new(controller(), owner_hash());
    set(controller(), 7_000_000_000_000_000_000_000 + 2 * NEAR);
    e.buy(plan(Venue::Dcl, true), 150);
}

#[test]
#[should_panic(expected = "Executor already holds a position")]
fn one_position_per_executor() {
    let mut e = setup();
    e.buy(plan(Venue::Dcl, true), 150);
    e.buy(plan(Venue::Dcl, true), 150);
}

#[test]
#[should_panic(expected = "No open position")]
fn sell_needs_position() {
    let mut e = setup();
    e.sell(plan(Venue::Dcl, false));
}

// ── Buy accounting ───────────────────────────────────────────────────────────

#[test]
fn full_buy_pays_full_fee_and_records_value() {
    let mut e = setup();
    e.status = Status::Open;
    let (amount, swap, fee, before) = (NEAR, NEAR * 9850 / 10_000, NEAR * 150 / 10_000, 2 * NEAR);
    callback(CREATION + 2 * NEAR, vec![u128_result(0), u128_result(swap)]);
    e.on_buy("c1".into(), amount, swap, 150, before, ResultKind::FtUsed, 1, false);
    assert_eq!(e.status, Status::Open);
    assert_eq!(e.value_after_buy, before - swap - fee);
}

#[test]
fn fee_is_a_plain_transfer_to_the_treasury() {
    let mut e = setup();
    e.status = Status::Open;
    let (amount, swap, fee) = (NEAR, NEAR * 9850 / 10_000, NEAR * 150 / 10_000);
    callback(CREATION + 2 * NEAR, vec![u128_result(0), u128_result(swap)]);
    e.on_buy("c1".into(), amount, swap, 150, 2 * NEAR, ResultKind::FtUsed, 1, false);
    let receipts = near_sdk::test_utils::get_created_receipts();
    let to_treasury: Vec<_> = receipts.iter().filter(|r| r.receiver_id.as_str() == "racerbottreasury.near").collect();
    assert_eq!(to_treasury.len(), 1, "one fee receipt to the treasury");
    match &to_treasury[0].actions[..] {
        [near_sdk::mock::MockAction::Transfer { deposit, .. }] => assert_eq!(deposit.as_yoctonear(), fee),
        other => panic!("fee must be a plain transfer, got {other:?}"),
    }
    assert!(receipts.iter().all(|r| r.receiver_id.as_str() != "racerbot.near" || r.actions.iter().all(|a| !matches!(a, near_sdk::mock::MockAction::FunctionCallWeight { .. }))),
        "nothing calls the controller back");
}

#[test]
fn partial_buy_pays_fee_pro_rata() {
    let mut e = setup();
    e.status = Status::Open;
    // 1.5% on 1 NEAR: swap 0.985, fee 0.015; a quarter used pays a quarter of the fee
    let (amount, swap) = (NEAR, NEAR * 9850 / 10_000);
    callback(CREATION + 2 * NEAR, vec![u128_result(swap / 4)]);
    e.on_buy("c1".into(), amount, swap, 150, 2 * NEAR, ResultKind::FtUsed, 0, false);
    let fee_paid = (swap / 4) * 150 / 9_850;
    assert_eq!(e.value_after_buy, 2 * NEAR - swap / 4 - fee_paid);
    assert!(fee_paid.abs_diff((amount - swap) / 4) <= 1);
}

#[test]
fn large_buy_fee_does_not_overflow() {
    let mut e = setup();
    e.status = Status::Open;
    let (amount, swap) = (10_000 * NEAR, 10_000 * NEAR * 9850 / 10_000);
    callback(CREATION + 20_000 * NEAR, vec![u128_result(swap)]);
    e.on_buy("c1".into(), amount, swap, 150, 20_000 * NEAR, ResultKind::FtUsed, 0, false);
    assert_eq!(e.value_after_buy, 20_000 * NEAR - amount);
}

#[test]
fn failed_buy_returns_to_ready_without_fee() {
    let mut e = setup();
    e.status = Status::Open;
    callback(CREATION + 2 * NEAR, vec![PromiseResult::Failed]);
    e.on_buy("c1".into(), NEAR, NEAR, 0, 2 * NEAR, ResultKind::Attached, 0, false);
    assert_eq!(e.status, Status::Ready);
    assert_eq!(e.value_after_buy, 0);
}

#[test]
fn attached_buy_success_spends_all() {
    let mut e = setup();
    e.status = Status::Open;
    let (amount, swap) = (NEAR, NEAR * 9850 / 10_000);
    callback(CREATION + 2 * NEAR, vec![PromiseResult::Successful(b"null".to_vec())]);
    e.on_buy("c1".into(), amount, swap, 150, 2 * NEAR, ResultKind::Attached, 0, false);
    assert_eq!(e.value_after_buy, 2 * NEAR - amount);
}

// ── Exit accounting ──────────────────────────────────────────────────────────

#[test]
fn exit_charges_sell_fee_on_proceeds_only() {
    let mut e = setup();
    e.status = Status::Open;
    e.wnear_registered = true;
    e.value_after_buy = NEAR / 2;
    callback(CREATION + 3 * NEAR, vec![]);
    e.on_exit_measured(150);
    let fee = (3 * NEAR - NEAR / 2) * 150 / 10_000;
    assert_eq!(e.status, Status::Exiting);
    assert_eq!(e.exit_amount, 3 * NEAR - fee);
}

#[test]
fn exit_of_unused_executor_is_free() {
    let mut e = setup();
    callback(CREATION + 2 * NEAR, vec![]);
    e.on_exit_measured(200);
    assert_eq!(e.exit_amount, 2 * NEAR);
}

#[test]
fn empty_exit_goes_straight_to_closable() {
    let mut e = funded(0);
    callback(CREATION, vec![]);
    e.on_exit_measured(150);
    assert_eq!(e.exit_amount, 0);
    assert_eq!(e.status, Status::Exited);
}

#[test]
fn close_tolerates_refunded_registrations() {
    let mut e = setup();
    e.status = Status::Exited;
    callback(CREATION + 2 * STORAGE_DEPOSIT, vec![u128_result(0)]);
    e.on_close_checked();
}

#[test]
fn exit_at_a_loss_pays_no_fee() {
    let mut e = setup();
    e.status = Status::Open;
    e.wnear_registered = true;
    e.value_after_buy = 5 * NEAR;
    callback(CREATION + 2 * NEAR, vec![]);
    e.on_exit_measured(150);
    assert_eq!(e.exit_amount, 2 * NEAR);
}

#[test]
fn second_prepare_charges_no_second_fee() {
    let mut e = setup();
    e.status = Status::Exiting;
    e.wnear_registered = true;
    callback(CREATION + 3 * NEAR, vec![]);
    e.on_exit_measured(150);
    assert_eq!(e.exit_amount, 3 * NEAR);
}

#[test]
#[should_panic(expected = "Amount above the measured exit amount")]
fn exit_cannot_send_more_than_measured() {
    let mut e = setup();
    e.status = Status::Exiting;
    e.exit_amount = NEAR;
    e.exit_to_intents("b2db50c1c15177555af28113fabc56a1be33a21adbea71b635b7a45e8b02e2d7".parse().unwrap(), NEAR + 1);
}

#[test]
fn owner_exit_sends_measured_amount() {
    let mut e = setup();
    e.status = Status::Exiting;
    e.wnear_registered = true;
    e.exit_amount = NEAR;
    e.exit_to_owner(owner_addr(), SALT.into());
    assert_eq!(e.exit_amount, 0);
}

#[test]
fn failed_exit_requires_a_fresh_prepare() {
    let mut e = setup();
    e.status = Status::Exiting;
    callback(CREATION + 2 * NEAR, vec![PromiseResult::Failed]);
    e.on_exit_sent(owner_addr(), NEAR, 0, false);
    assert_eq!(e.status, Status::Exiting);
    assert_eq!(e.exit_amount, 0);
}

#[test]
fn partial_exit_stays_exiting_until_the_rest_is_sent() {
    let mut e = setup();
    e.status = Status::Exiting;
    e.exit_amount = NEAR / 4; // left after sending a rounded part
    callback(CREATION + NEAR, vec![PromiseResult::Successful(vec![])]);
    e.on_exit_sent(owner_addr(), NEAR, 0, false);
    assert_eq!(e.status, Status::Exiting);
    assert_eq!(e.exit_amount, NEAR / 4);
}

#[test]
fn successful_exit_marks_exited() {
    let mut e = setup();
    e.status = Status::Exiting;
    callback(CREATION + 2 * NEAR, vec![PromiseResult::Successful(vec![])]);
    e.on_exit_sent(owner_addr(), NEAR, 0, false);
    assert_eq!(e.status, Status::Exited);
    assert_eq!(e.exited_at_block, 1_000);
}

// ── Owner checks ─────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Not the owner's address")]
fn sweep_rejects_wrong_salt() {
    let mut e = setup();
    set(owner_addr(), NEAR);
    e.sweep(meme(), owner_addr(), "wrong".into());
}

#[test]
#[should_panic(expected = "Not the owner's address")]
fn sweep_rejects_other_address() {
    let mut e = setup();
    set(owner_addr(), NEAR);
    e.sweep(meme(), "attacker.near".parse().unwrap(), SALT.into());
}

#[test]
fn sweep_accepts_owner_with_salt() {
    let mut e = setup();
    set("anyone.near".parse().unwrap(), NEAR);
    e.sweep(meme(), owner_addr(), SALT.into());
}

#[test]
#[should_panic(expected = "wNEAR leaves through an exit")]
fn sweep_cannot_move_wnear() {
    let mut e = setup();
    e.sweep(wnear(), owner_addr(), SALT.into());
}

#[test]
#[should_panic(expected = "Not the owner's address")]
fn exit_to_owner_checks_address() {
    let mut e = setup();
    e.status = Status::Exiting;
    e.exit_to_owner("attacker.near".parse().unwrap(), SALT.into());
}

#[test]
#[should_panic(expected = "Controller still active")]
fn owner_exit_waits_for_timeout() {
    let mut e = setup();
    e.owner_exit(owner_addr(), SALT.into());
}

#[test]
fn owner_exit_after_timeout() {
    let mut e = setup();
    let mut c = ctx("anyone.near".parse().unwrap(), CREATION + 2 * NEAR);
    c.block_timestamp(1_000_000_000 + OWNER_EXIT_AFTER_NS);
    testing_env!(c.build());
    e.owner_exit(owner_addr(), SALT.into());
}

// ── Close ────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Close delay not over")]
fn close_waits_for_delay() {
    let mut e = setup();
    e.status = Status::Exited;
    e.exited_at_block = 1_000;
    set("anyone.near".parse().unwrap(), NEAR);
    e.finish_close();
}

#[test]
#[should_panic(expected = "A tracked balance is not zero")]
fn close_refuses_leftover_tokens() {
    let mut e = setup();
    e.status = Status::Exited;
    e.tokens = vec![meme()];
    callback(CREATION, vec![u128_result(0), u128_result(5)]);
    e.on_close_checked();
}

#[test]
#[should_panic(expected = "NEAR left: exit first")]
fn close_refuses_leftover_near() {
    let mut e = setup();
    e.status = Status::Exited;
    callback(CREATION + NEAR, vec![u128_result(0)]);
    e.on_close_checked();
}

#[test]
fn close_proceeds_when_empty() {
    let mut e = setup();
    e.status = Status::Exited;
    e.tokens = vec![meme()];
    callback(CREATION, vec![u128_result(0), u128_result(0)]);
    e.on_close_checked();
}

// ── Venue messages ───────────────────────────────────────────────────────────

#[test]
fn dcl_sell_keeps_wnear() {
    set(controller(), NEAR);
    assert_eq!(
        dcl_msg(&plan(Venue::Dcl, false)),
        r#"{"Swap":{"pool_ids":["meme.near|wrap.near|10000"],"output_token":"wrap.near","min_output_amount":"5","skip_unwrap_near":true}}"#
    );
}

#[test]
fn dcl_buy_outputs_token() {
    set(controller(), NEAR);
    assert!(dcl_msg(&plan(Venue::Dcl, true)).contains(r#""output_token":"meme.near""#));
}

#[test]
fn ref_message_spends_first_hop_only() {
    set(controller(), NEAR);
    let mut p = plan(Venue::RefAmm, true);
    p.hops.push(Hop { pool_id: Some(9), dcl_pool_id: None, token_in: "meme.near".into(), token_out: "usdc.near".into(), min_amount_out: 7 });
    assert_eq!(
        ref_msg(&p, 42),
        r#"{"force":0,"actions":[{"pool_id":274,"token_in":"wrap.near","amount_in":"42","token_out":"meme.near","min_amount_out":"5"},{"pool_id":9,"token_in":"meme.near","amount_in":"0","token_out":"usdc.near","min_amount_out":"7"}],"referral_id":null}"#
    );
}

#[test]
fn intear_buy_withdraws_token_to_executor() {
    set(controller(), NEAR);
    assert_eq!(
        intear_ops(&plan(Venue::Intear, true), 42, true),
        r#"{"referrer":"dex-aggregator.intear.near","operations":[{"SwapSimple":{"dex_id":"slimedragon.near/xyk","asset_in":"near","asset_out":"nep141:meme.near","amount":{"Amount":{"ExactIn":"42"}},"constraint":"5","message":"EgEAAA=="}},{"Withdraw":{"asset_id":"nep141:meme.near","amount":{"Full":{"at_least":"5"}},"to":null,"rescue_address":null}}]}"#
    );
}

#[test]
fn intear_sell_withdraws_near() {
    set(controller(), NEAR);
    let ops = intear_ops(&plan(Venue::Intear, false), 42, false);
    assert!(ops.contains(r#""asset_in":"nep141:meme.near","asset_out":"near""#));
    assert!(ops.contains(r#"{"Withdraw":{"asset_id":"near","#));
}

#[test]
fn intear_two_hop_chains_output() {
    set(controller(), NEAR);
    let mut p = plan(Venue::Intear, true);
    p.hops = vec![
        Hop { pool_id: Some(274), dcl_pool_id: None, token_in: "near".into(), token_out: "token.intear.near".into(), min_amount_out: 0 },
        Hop { pool_id: Some(5), dcl_pool_id: None, token_in: "token.intear.near".into(), token_out: "meme.near".into(), min_amount_out: 5 },
    ];
    let ops = intear_ops(&p, 42, true);
    assert!(ops.contains(r#""amount":"OutputOfLastIn","constraint":"5""#));
    assert!(ops.contains(r#""amount":{"Amount":{"ExactIn":"42"}},"constraint":null"#));
}

#[test]
fn ft_call_args_escape_message() {
    let args = String::from_utf8(ft_call_args("dclv2.ref-labs.near", 7, r#"{"a":"b"}"#)).unwrap();
    assert_eq!(args, r#"{"receiver_id":"dclv2.ref-labs.near","amount":"7","msg":"{\"a\":\"b\"}"}"#);
}

#[test]
#[should_panic(expected = "Bad identifier")]
fn injected_pool_id_rejected() {
    set(controller(), NEAR);
    let mut p = plan(Venue::Dcl, true);
    p.hops[0].dcl_pool_id = Some(r#"x"],"output_token":"evil"#.into());
    dcl_msg(&p);
}

#[test]
#[should_panic(expected = "Bonding curve not allowed")]
fn bonding_curve_target_restricted() {
    let mut e = setup();
    e.buy(plan(Venue::BondingCurve, true), 150);
}

#[test]
fn bonding_curve_buy_allowed_on_nearpumpfun() {
    let mut e = setup();
    let mut p = plan(Venue::BondingCurve, true);
    p.token = "cat.nearpumpfun.near".parse().unwrap();
    e.buy(p, 150);
    assert_eq!(e.status, Status::Open);
}

#[test]
#[should_panic(expected = "Receiver not allowed")]
fn launchpad_receiver_restricted() {
    let mut e = setup();
    e.status = Status::Open;
    let mut p = plan(Venue::Launchpad, false);
    p.receiver = Some("attacker.near".parse().unwrap());
    e.sell(p);
}

#[test]
fn launchpad_message() {
    assert_eq!(launchpad_msg(&plan(Venue::Launchpad, true)), r#"{"token":"meme.near"}"#);
}

#[test]
fn base64_matches_standard() {
    assert_eq!(base64_4(274u32.to_le_bytes()), "EgEAAA==");
    assert_eq!(base64_4(0u32.to_le_bytes()), "AAAAAA==");
    assert_eq!(base64_4(u32::MAX.to_le_bytes()), "/////w==");
}

#[test]
fn read_u128_parses_quoted() {
    callback(NEAR, vec![u128_result(123), PromiseResult::Successful(b"oops".to_vec())]);
    assert_eq!(read_u128(0), Some(123));
    assert_eq!(read_u128(1), None);
}

#[test]
fn clean_strips_unsafe_characters() {
    assert_eq!(clean(r#"intent_1"},"x":1"#), "intent_1x1");
}

// ── Rolled-back receipts and close safety ────────────────────────────────────

#[test]
fn rolled_back_buy_unsets_wnear_registration() {
    let mut e = setup();
    set(controller(), CREATION + 2 * NEAR);
    e.buy(plan(Venue::Dcl, true), 150);
    assert!(e.wnear_registered);
    let reserve_after_buy = e.reserve;
    // Token registration succeeded; the wrap-and-send receipt rolled back
    callback(CREATION + 2 * NEAR, vec![PromiseResult::Successful(b"{}".to_vec()), PromiseResult::Failed]);
    e.on_buy("c1".into(), NEAR, NEAR * 9850 / 10_000, 150, 2 * NEAR, ResultKind::FtUsed, 1, true);
    assert_eq!(e.status, Status::Ready);
    assert!(!e.wnear_registered);
    assert_eq!(e.reserve, reserve_after_buy + STORAGE_DEPOSIT);
    assert_eq!(e.tokens, vec![meme()]);
}

#[test]
fn failed_token_registration_stops_tracking_the_token() {
    let mut e = setup();
    e.status = Status::Open;
    e.tokens = vec![meme()];
    let reserve = e.reserve;
    callback(CREATION + 2 * NEAR, vec![PromiseResult::Failed, PromiseResult::Failed]);
    e.on_buy("c1".into(), NEAR, NEAR, 0, 2 * NEAR, ResultKind::Attached, 1, false);
    assert!(e.tokens.is_empty());
    assert_eq!(e.reserve, reserve + STORAGE_DEPOSIT);
}

#[test]
fn long_success_result_still_counts_as_bought() {
    let mut e = setup();
    e.status = Status::Open;
    let (amount, swap) = (NEAR, NEAR * 9850 / 10_000);
    callback(CREATION + 2 * NEAR, vec![PromiseResult::Successful(vec![b'x'; 1_000])]);
    e.on_buy("c1".into(), amount, swap, 150, 2 * NEAR, ResultKind::Attached, 0, false);
    assert_eq!(e.status, Status::Open);
    assert_eq!(e.value_after_buy, 2 * NEAR - amount);
}

#[test]
#[should_panic(expected = "Too many tokens")]
fn token_list_is_capped() {
    let mut e = setup();
    e.tokens = (0..MAX_TOKENS).map(|i| format!("t{}.near", i).parse().unwrap()).collect();
    set(controller(), CREATION + 2 * NEAR);
    e.buy(plan(Venue::Dcl, true), 150);
}

#[test]
fn rolled_back_intents_exit_restores_registrations() {
    let mut e = setup();
    e.status = Status::Exiting;
    e.exit_amount = NEAR;
    let reserve = e.reserve;
    set(controller(), CREATION + 2 * NEAR);
    e.exit_to_intents("b2db50c1c15177555af28113fabc56a1be33a21adbea71b635b7a45e8b02e2d7".parse().unwrap(), NEAR);
    assert!(e.wnear_registered);
    assert_eq!(e.reserve, reserve - 2 * STORAGE_DEPOSIT);
    callback(CREATION + 2 * NEAR, vec![PromiseResult::Failed]);
    e.on_exit_sent(owner_addr(), NEAR, 2 * STORAGE_DEPOSIT, true);
    assert!(!e.wnear_registered);
    assert_eq!(e.reserve, reserve);
    assert_eq!(e.status, Status::Exiting);
}

#[test]
fn close_is_blocked_when_an_unregister_fails() {
    let mut e = setup();
    e.status = Status::Exited;
    callback(CREATION, vec![PromiseResult::Successful(b"true".to_vec()), PromiseResult::Failed]);
    match e.on_close_delete(2) {
        PromiseOrValue::Value(()) => {}
        PromiseOrValue::Promise(_) => panic!("must not delete"),
    }
    assert_eq!(e.status, Status::Exited);
}

#[test]
fn close_deletes_when_unregisters_succeed_or_were_not_needed() {
    let mut e = setup();
    e.status = Status::Exited;
    callback(CREATION, vec![PromiseResult::Successful(b"true".to_vec()), PromiseResult::Successful(b"false".to_vec())]);
    assert!(matches!(e.on_close_delete(2), PromiseOrValue::Promise(_)));
}

// Same bytes as the api's executorPool.test.ts (executorInitArgs / exitToIntentsArgs): the bot encodes
// these by hand, so both sides pin the layout
#[test]
fn borsh_args_match_the_bot() {
    let mut init = hex_bytes(&("0d000000".to_string() + &hex_of(b"racerbot.near") + "20000000" + &"ab".repeat(32)));
    let (controller, owner_hash): (AccountId, Vec<u8>) = near_sdk::borsh::from_slice(&init).unwrap();
    assert_eq!(controller.as_str(), "racerbot.near");
    assert_eq!(owner_hash, vec![0xab; 32]);
    init.clear();
    let exit = hex_bytes(&("06000000".to_string() + &hex_of(b"a.near") + "0500000000000000" + "0100000000000000"));
    let (to, amount): (AccountId, u128) = near_sdk::borsh::from_slice(&exit).unwrap();
    assert_eq!(to.as_str(), "a.near");
    assert_eq!(amount, (1u128 << 64) + 5);
}

fn hex_of(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }
fn hex_bytes(s: &str) -> Vec<u8> { (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect() }

/// The bot (packages/api executorPlan.ts) must produce exactly these bytes for this plan; executorPlan.test.ts
/// holds the same vector. `buy` takes the plan followed by fee_bps (u32 LE).
#[test]
fn plan_borsh_vector() {
    let p = SwapPlan {
        venue: Venue::Intear,
        token: "meme.near".parse().unwrap(),
        hops: vec![Hop {
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
    };
    let bytes = near_sdk::borsh::to_vec(&p).unwrap();
    assert_eq!(hex_of(&bytes), "02090000006d656d652e6e6561720100000001120100000000000001190000006d656d652e6e6561727c777261702e6e6561727c3130303030040000006e656172090000006d656d652e6e65617205000000000000000000000000000000e80300000000000000000000000000000500000000000000000000000000000001150000006761797061642e6a312d726163696e672e6e65617200d2496b0000000008000000696e74656e745f31");
    let mut buy_args = bytes.clone();
    buy_args.extend_from_slice(&150u32.to_le_bytes());
    let (decoded, fee): (SwapPlan, u32) = near_sdk::borsh::from_slice(&buy_args).unwrap();
    assert_eq!(decoded.correlation_id, "intent_1");
    assert_eq!(fee, 150);
}
