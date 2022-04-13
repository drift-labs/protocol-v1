use solana_program::msg;

use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::amm::{calculate_quote_asset_amount_swapped, calculate_spread_reserves};
use crate::math::casting::{cast, cast_to_i128};
use crate::math::constants::PRICE_TO_PEG_PRECISION_RATIO;
use crate::math::{amm, bn, quote_asset::*};
use crate::math_error;
use crate::state::market::AMM;
use std::cmp::Ordering;

#[derive(Clone, Copy, PartialEq)]
pub enum SwapDirection {
    Add,
    Remove,
}

#[derive(Clone, Copy, PartialEq)]
pub enum AssetType {
    Quote,
    Base,
}

pub fn swap_quote_asset(
    amm: &mut AMM,
    quote_asset_amount: u128,
    direction: SwapDirection,
    now: i64,
    precomputed_mark_price: Option<u128>,
    use_spread: bool,
) -> ClearingHouseResult<(i128, u128)> {
    amm::update_mark_twap(amm, now, precomputed_mark_price)?;

    let (
        new_base_asset_reserve,
        new_quote_asset_reserve,
        base_asset_amount,
        quote_asset_amount_surplus,
    ) = match use_spread {
        true => calculate_quote_swap_output_with_spread(
            amm,
            quote_asset_amount,
            direction,
            precomputed_mark_price,
        )?,
        false => calculate_quote_swap_output_without_spread(amm, quote_asset_amount, direction)?,
    };

    amm.base_asset_reserve = new_base_asset_reserve;
    amm.quote_asset_reserve = new_quote_asset_reserve;

    Ok((base_asset_amount, quote_asset_amount_surplus))
}

fn calculate_quote_swap_output_without_spread(
    amm: &mut AMM,
    quote_asset_amount: u128,
    direction: SwapDirection,
) -> ClearingHouseResult<(u128, u128, i128, u128)> {
    let quote_asset_reserve_amount =
        asset_to_reserve_amount(quote_asset_amount, amm.peg_multiplier)?;

    if quote_asset_reserve_amount < amm.minimum_quote_asset_trade_size {
        return Err(ErrorCode::TradeSizeTooSmall);
    }

    let initial_base_asset_reserve = amm.base_asset_reserve;
    let (new_base_asset_reserve, new_quote_asset_reserve) = amm::calculate_swap_output(
        quote_asset_reserve_amount,
        amm.quote_asset_reserve,
        direction,
        amm.sqrt_k,
    )?;

    let base_asset_amount = cast_to_i128(initial_base_asset_reserve)?
        .checked_sub(cast(new_base_asset_reserve)?)
        .ok_or_else(math_error!())?;

    Ok((
        new_base_asset_reserve,
        new_quote_asset_reserve,
        base_asset_amount,
        0,
    ))
}

fn calculate_quote_swap_output_with_spread(
    amm: &mut AMM,
    quote_asset_amount: u128,
    direction: SwapDirection,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<(u128, u128, i128, u128)> {
    let quote_asset_reserve_amount =
        asset_to_reserve_amount(quote_asset_amount, amm.peg_multiplier)?;

    if quote_asset_reserve_amount < amm.minimum_quote_asset_trade_size {
        return Err(ErrorCode::TradeSizeTooSmall);
    }

    // first do the swap with spread reserves to figure out how much base asset is acquired
    let (base_asset_reserve_with_spread, quote_asset_reserve_with_spread) =
        calculate_spread_reserves(amm, precomputed_mark_price, direction, AssetType::Quote)?;

    let (new_base_asset_reserve_with_spread, new_quote_asset_reserve_with_spread) =
        amm::calculate_swap_output(
            quote_asset_reserve_amount,
            quote_asset_reserve_with_spread,
            direction,
            amm.sqrt_k,
        )?;

    let base_asset_amount = cast_to_i128(base_asset_reserve_with_spread)?
        .checked_sub(cast(new_base_asset_reserve_with_spread)?)
        .ok_or_else(math_error!())?;

    // second do the swap based on normal reserves to get updated reserves
    let (new_base_asset_reserve, new_quote_asset_reserve) = amm::calculate_swap_output(
        quote_asset_reserve_amount,
        amm.quote_asset_reserve,
        direction,
        amm.sqrt_k,
    )?;

    let quote_asset_amount_surplus =
        match new_quote_asset_reserve.cmp(&new_quote_asset_reserve_with_spread) {
            Ordering::Greater => new_quote_asset_reserve - new_quote_asset_reserve_with_spread,
            Ordering::Less => new_quote_asset_reserve_with_spread - new_quote_asset_reserve,
            Ordering::Equal => 0,
        };

    Ok((
        new_base_asset_reserve,
        new_quote_asset_reserve,
        base_asset_amount,
        quote_asset_amount_surplus,
    ))
}

pub fn swap_base_asset(
    amm: &mut AMM,
    base_asset_swap_amount: u128,
    direction: SwapDirection,
    now: i64,
    precomputed_mark_price: Option<u128>,
    use_spread: bool,
) -> ClearingHouseResult<(u128, u128)> {
    amm::update_mark_twap(amm, now, precomputed_mark_price)?;

    let (
        new_base_asset_reserve,
        new_quote_asset_reserve,
        quote_asset_amount,
        quote_asset_amount_surplus,
    ) = match use_spread {
        true => calculate_base_swap_output_with_spread(
            amm,
            base_asset_swap_amount,
            direction,
            precomputed_mark_price,
        )?,
        false => calculate_base_swap_output_without_spread(amm, base_asset_swap_amount, direction)?,
    };

    amm.base_asset_reserve = new_base_asset_reserve;
    amm.quote_asset_reserve = new_quote_asset_reserve;

    Ok((quote_asset_amount, quote_asset_amount_surplus))
}

fn calculate_base_swap_output_without_spread(
    amm: &mut AMM,
    base_asset_swap_amount: u128,
    direction: SwapDirection,
) -> ClearingHouseResult<(u128, u128, u128, u128)> {
    let initial_quote_asset_reserve = amm.quote_asset_reserve;
    let (new_quote_asset_reserve, new_base_asset_reserve) = amm::calculate_swap_output(
        base_asset_swap_amount,
        amm.base_asset_reserve,
        direction,
        amm.sqrt_k,
    )?;

    let quote_asset_amount = calculate_quote_asset_amount_swapped(
        initial_quote_asset_reserve,
        new_quote_asset_reserve,
        direction,
        amm.peg_multiplier,
    )?;

    Ok((
        new_base_asset_reserve,
        new_quote_asset_reserve,
        quote_asset_amount,
        0,
    ))
}

fn calculate_base_swap_output_with_spread(
    amm: &mut AMM,
    base_asset_swap_amount: u128,
    direction: SwapDirection,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<(u128, u128, u128, u128)> {
    // first do the swap with spread reserves to figure out how much base asset is acquired
    let (base_asset_reserve_with_spread, quote_asset_reserve_with_spread) =
        calculate_spread_reserves(amm, precomputed_mark_price, direction, AssetType::Base)?;

    let (new_quote_asset_reserve_with_spread, _) = amm::calculate_swap_output(
        base_asset_swap_amount,
        base_asset_reserve_with_spread,
        direction,
        amm.sqrt_k,
    )?;

    let quote_asset_amount = calculate_quote_asset_amount_swapped(
        quote_asset_reserve_with_spread,
        new_quote_asset_reserve_with_spread,
        direction,
        amm.peg_multiplier,
    )?;

    let (new_quote_asset_reserve, new_base_asset_reserve) = amm::calculate_swap_output(
        base_asset_swap_amount,
        amm.base_asset_reserve,
        direction,
        amm.sqrt_k,
    )?;

    let quote_asset_amount_surplus =
        match new_quote_asset_reserve.cmp(&new_quote_asset_reserve_with_spread) {
            Ordering::Greater => new_quote_asset_reserve - new_quote_asset_reserve_with_spread,
            Ordering::Less => new_quote_asset_reserve_with_spread - new_quote_asset_reserve,
            Ordering::Equal => 0,
        };

    Ok((
        new_base_asset_reserve,
        new_quote_asset_reserve,
        quote_asset_amount,
        quote_asset_amount_surplus,
    ))
}

pub fn move_price(
    amm: &mut AMM,
    base_asset_reserve: u128,
    quote_asset_reserve: u128,
) -> ClearingHouseResult {
    amm.base_asset_reserve = base_asset_reserve;
    amm.quote_asset_reserve = quote_asset_reserve;

    let k = bn::U256::from(base_asset_reserve)
        .checked_mul(bn::U256::from(quote_asset_reserve))
        .ok_or_else(math_error!())?;

    amm.sqrt_k = k.integer_sqrt().try_to_u128()?;

    Ok(())
}

#[allow(dead_code)]
pub fn move_to_price(amm: &mut AMM, target_price: u128) -> ClearingHouseResult {
    let sqrt_k = bn::U256::from(amm.sqrt_k);
    let k = sqrt_k.checked_mul(sqrt_k).ok_or_else(math_error!())?;

    let new_base_asset_amount_squared = k
        .checked_mul(bn::U256::from(amm.peg_multiplier))
        .ok_or_else(math_error!())?
        .checked_mul(bn::U256::from(PRICE_TO_PEG_PRECISION_RATIO))
        .ok_or_else(math_error!())?
        .checked_div(bn::U256::from(target_price))
        .ok_or_else(math_error!())?;

    let new_base_asset_amount = new_base_asset_amount_squared.integer_sqrt();
    let new_quote_asset_amount = k
        .checked_div(new_base_asset_amount)
        .ok_or_else(math_error!())?;

    amm.base_asset_reserve = new_base_asset_amount.try_to_u128()?;
    amm.quote_asset_reserve = new_quote_asset_amount.try_to_u128()?;

    Ok(())
}
