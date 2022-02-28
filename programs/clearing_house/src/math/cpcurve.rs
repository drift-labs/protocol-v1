use std::cmp::{max, min};

use anchor_lang::prelude::AccountInfo;
use solana_program::msg;

use crate::controller::amm::SwapDirection;
use crate::controller::position::PositionDirection;
use crate::error::*;
use crate::math::bn;
use crate::math::bn::U192;
use crate::math::casting::{cast, cast_to_i128, cast_to_u128};
use crate::math::constants::{MARK_PRICE_PRECISION, PEG_PRECISION, PRICE_TO_PEG_PRECISION_RATIO};
use crate::math::position::_calculate_base_asset_value_and_pnl;
use crate::math::quote_asset::{asset_to_reserve_amount, reserve_to_asset_amount};
use crate::math_error;
use crate::state::market::{Market, AMM};
use crate::state::state::{PriceDivergenceGuardRails, ValidityGuardRails};

pub fn calculate_price(
    quote_asset_reserve: u128,
    base_asset_reserve: u128,
    peg_multiplier: u128,
) -> ClearingHouseResult<u128> {
    let peg_quote_asset_amount = quote_asset_reserve
        .checked_mul(peg_multiplier)
        .ok_or_else(math_error!())?;

    U192::from(peg_quote_asset_amount)
        .checked_mul(U192::from(PRICE_TO_PEG_PRECISION_RATIO))
        .ok_or_else(math_error!())?
        .checked_div(U192::from(base_asset_reserve))
        .ok_or_else(math_error!())?
        .try_to_u128()
}

pub fn calculate_swap_output(
    swap_amount: u128,
    input_asset_amount: u128,
    direction: SwapDirection,
    invariant_sqrt: u128,
) -> ClearingHouseResult<(u128, u128)> {
    let invariant_sqrt_u192 = U192::from(invariant_sqrt);
    let invariant = invariant_sqrt_u192
        .checked_mul(invariant_sqrt_u192)
        .ok_or_else(math_error!())?;

    if direction == SwapDirection::Remove && swap_amount > input_asset_amount {
        return Err(ErrorCode::TradeSizeTooLarge);
    }

    let new_input_amount = if let SwapDirection::Add = direction {
        input_asset_amount
            .checked_add(swap_amount)
            .ok_or_else(math_error!())?
    } else {
        input_asset_amount
            .checked_sub(swap_amount)
            .ok_or_else(math_error!())?
    };

    let new_input_amount_u192 = U192::from(new_input_amount);
    let new_output_amount = invariant
        .checked_div(new_input_amount_u192)
        .ok_or_else(math_error!())?
        .try_to_u128()?;

    Ok((new_output_amount, new_input_amount))
}
