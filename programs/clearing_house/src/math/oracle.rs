use crate::error::ClearingHouseResult;
use crate::math::amm;
use crate::state::market::AMM;
use crate::state::state::OracleGuardRails;
use anchor_lang::prelude::AccountInfo;
use solana_program::clock::Slot;

pub fn block_operation(
    amm: &AMM,
    oracle_account_info: &AccountInfo,
    clock_slot: Slot,
    guard_rails: &OracleGuardRails,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<(bool, i128)> {
    let OracleStatus {
        price: oracle_price,
        is_valid: oracle_is_valid,
        mark_too_divergent: is_oracle_mark_too_divergent,
        oracle_mark_spread_pct: _,
    } = get_oracle_status(
        amm,
        oracle_account_info,
        clock_slot,
        guard_rails,
        precomputed_mark_price,
    )?;

    let block = !oracle_is_valid || is_oracle_mark_too_divergent;
    Ok((block, oracle_price))
}

#[derive(Default, Clone, Copy, Debug)]
pub struct OracleStatus {
    pub price: i128,
    pub oracle_mark_spread_pct: i128,
    pub is_valid: bool,
    pub mark_too_divergent: bool,
}

pub fn get_oracle_status(
    amm: &AMM,
    oracle_account_info: &AccountInfo,
    clock_slot: Slot,
    guard_rails: &OracleGuardRails,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<OracleStatus> {
    let oracle_price_data = &amm.get_oracle_price(oracle_account_info, clock_slot)?;
    let oracle_is_valid = amm::is_oracle_valid(oracle_price_data, &guard_rails.validity)?;
    let oracle_mark_spread_pct =
        amm::calculate_oracle_mark_spread_pct(amm, oracle_price_data, 0, precomputed_mark_price)?;
    let is_oracle_mark_too_divergent =
        amm::is_oracle_mark_too_divergent(oracle_mark_spread_pct, &guard_rails.price_divergence)?;

    Ok(OracleStatus {
        price: oracle_price_data.price,
        oracle_mark_spread_pct,
        is_valid: oracle_is_valid,
        mark_too_divergent: is_oracle_mark_too_divergent,
    })
}
