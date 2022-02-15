use crate::error::*;
use crate::math::collateral::calculate_updated_collateral;
use crate::math::constants::MARGIN_PRECISION;
use crate::math::position::calculate_base_asset_value_and_pnl;
use crate::math_error;
use crate::state::market::Markets;
use crate::state::user::{User, UserPositions};
use std::cell::{Ref, RefMut};

use solana_program::msg;

pub fn calculate_margin_ratio(
    user: &User,
    user_positions: &RefMut<UserPositions>,
    markets: &Ref<Markets>,
) -> ClearingHouseResult<(u128, i128, u128, u128)> {
    let mut base_asset_value: u128 = 0;
    let mut unrealized_pnl: i128 = 0;

    // loop 1 to calculate unrealized_pnl
    for market_position in user_positions.positions.iter() {
        if market_position.base_asset_amount == 0 {
            continue;
        }

        let amm = &markets.markets[Markets::index_from_u64(market_position.market_index)].amm;
        let (position_base_asset_value, position_unrealized_pnl) =
            calculate_base_asset_value_and_pnl(market_position, amm)?;

        base_asset_value = base_asset_value
            .checked_add(position_base_asset_value)
            .ok_or_else(math_error!())?;
        unrealized_pnl = unrealized_pnl
            .checked_add(position_unrealized_pnl)
            .ok_or_else(math_error!())?;
    }

    let total_collateral: u128;
    let margin_ratio: u128;
    if base_asset_value == 0 {
        total_collateral = user.collateral;
        margin_ratio = u128::MAX;
    } else {
        total_collateral = calculate_updated_collateral(user.collateral, unrealized_pnl)?;
        margin_ratio = total_collateral
            .checked_mul(MARGIN_PRECISION)
            .ok_or_else(math_error!())?
            .checked_div(base_asset_value)
            .ok_or_else(math_error!())?;
    }

    Ok((
        total_collateral,
        unrealized_pnl,
        base_asset_value,
        margin_ratio,
    ))
}

pub fn calculate_free_collateral(
    user: &User,
    user_positions: &mut UserPositions,
    markets: &Markets,
    max_leverage: u128,
    market_to_close: Option<u64>,
) -> ClearingHouseResult<(u128, u128)> {
    let mut closed_position_base_asset_value: u128 = 0;
    let mut base_asset_value: u128 = 0;
    let mut unrealized_pnl: i128 = 0;

    // loop to calculate unrealized_pnl
    for market_position in user_positions.positions.iter() {
        if market_position.base_asset_amount == 0 {
            continue;
        }

        let amm = &markets.markets[Markets::index_from_u64(market_position.market_index)].amm;
        let (position_base_asset_value, position_unrealized_pnl) =
            calculate_base_asset_value_and_pnl(market_position, amm)?;

        if market_to_close.is_some() && market_to_close.unwrap() == market_position.market_index {
            closed_position_base_asset_value = position_base_asset_value;
        } else {
            base_asset_value = base_asset_value
                .checked_add(position_base_asset_value)
                .ok_or_else(math_error!())?;
        }

        unrealized_pnl = unrealized_pnl
            .checked_add(position_unrealized_pnl)
            .ok_or_else(math_error!())?;
    }

    let total_collateral = if base_asset_value == 0 {
        user.collateral
    } else {
        calculate_updated_collateral(user.collateral, unrealized_pnl)?
    };

    let initial_margin_collateral_requirement = base_asset_value
        .checked_div(max_leverage)
        .ok_or_else(math_error!())?;

    let free_collateral = if initial_margin_collateral_requirement < total_collateral {
        total_collateral
            .checked_sub(initial_margin_collateral_requirement)
            .ok_or_else(math_error!())?
    } else {
        0
    };

    Ok((free_collateral, closed_position_base_asset_value))
}
