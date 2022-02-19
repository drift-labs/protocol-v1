use crate::error::*;
use crate::math::collateral::calculate_updated_collateral;
use crate::math::constants::MARGIN_PRECISION;
use crate::math::position::calculate_base_asset_value_and_pnl;
use crate::math_error;
use crate::state::market::Markets;
use crate::state::user::{User, UserPositions};
use std::cell::{Ref, RefMut};

use solana_program::msg;

pub fn meets_initial_margin_requirement(
    user: &User,
    user_positions: &RefMut<UserPositions>,
    markets: &Ref<Markets>,
) -> ClearingHouseResult<bool> {
    let mut initial_margin_requirement: u128 = 0;
    let mut unrealized_pnl: i128 = 0;

    for market_position in user_positions.positions.iter() {
        if market_position.base_asset_amount == 0 {
            continue;
        }

        let market = markets.get_market(market_position.market_index);
        let amm = &market.amm;
        let (position_base_asset_value, position_unrealized_pnl) =
            calculate_base_asset_value_and_pnl(market_position, amm)?;

        initial_margin_requirement = initial_margin_requirement
            .checked_add(
                position_base_asset_value
                    .checked_mul(market.margin_ratio_initial.into())
                    .ok_or_else(math_error!())?,
            )
            .ok_or_else(math_error!())?;

        unrealized_pnl = unrealized_pnl
            .checked_add(position_unrealized_pnl)
            .ok_or_else(math_error!())?;
    }

    initial_margin_requirement = initial_margin_requirement
        .checked_div(MARGIN_PRECISION)
        .ok_or_else(math_error!())?;

    let total_collateral = calculate_updated_collateral(user.collateral, unrealized_pnl)?;

    Ok(total_collateral >= initial_margin_requirement)
}

#[derive(PartialEq)]
pub enum LiquidationType {
    NONE,
    PARTIAL,
    FULL,
}

pub struct LiquidationStatus {
    pub liquidation_type: LiquidationType,
    pub total_collateral: u128,
    pub unrealized_pnl: i128,
    pub base_asset_value: u128,
}

pub fn calculate_liquidation_status(
    user: &User,
    user_positions: &RefMut<UserPositions>,
    markets: &Ref<Markets>,
) -> ClearingHouseResult<LiquidationStatus> {
    let mut partial_margin_requirement: u128 = 0;
    let mut maintenance_margin_requirement: u128 = 0;
    let mut base_asset_value: u128 = 0;
    let mut unrealized_pnl: i128 = 0;

    for market_position in user_positions.positions.iter() {
        if market_position.base_asset_amount == 0 {
            continue;
        }

        let market = markets.get_market(market_position.market_index);
        let amm = &market.amm;
        let (position_base_asset_value, position_unrealized_pnl) =
            calculate_base_asset_value_and_pnl(market_position, amm)?;

        base_asset_value = base_asset_value
            .checked_add(position_base_asset_value)
            .ok_or_else(math_error!())?;
        unrealized_pnl = unrealized_pnl
            .checked_add(position_unrealized_pnl)
            .ok_or_else(math_error!())?;

        partial_margin_requirement = partial_margin_requirement
            .checked_add(
                position_base_asset_value
                    .checked_mul(market.margin_ratio_partial.into())
                    .ok_or_else(math_error!())?,
            )
            .ok_or_else(math_error!())?;

        maintenance_margin_requirement = maintenance_margin_requirement
            .checked_add(
                position_base_asset_value
                    .checked_mul(market.margin_ratio_maintenance.into())
                    .ok_or_else(math_error!())?,
            )
            .ok_or_else(math_error!())?;
    }

    partial_margin_requirement = partial_margin_requirement
        .checked_div(MARGIN_PRECISION)
        .ok_or_else(math_error!())?;

    maintenance_margin_requirement = maintenance_margin_requirement
        .checked_div(MARGIN_PRECISION)
        .ok_or_else(math_error!())?;

    let total_collateral = calculate_updated_collateral(user.collateral, unrealized_pnl)?;

    let requires_partial_liquidation = total_collateral < partial_margin_requirement;
    let requires_full_liquidation = total_collateral < maintenance_margin_requirement;

    let liquidation_type = if requires_full_liquidation {
        LiquidationType::FULL
    } else if requires_partial_liquidation {
        LiquidationType::PARTIAL
    } else {
        LiquidationType::NONE
    };

    Ok(LiquidationStatus {
        liquidation_type,
        total_collateral,
        unrealized_pnl,
        base_asset_value,
    })
}

pub fn calculate_free_collateral(
    user: &User,
    user_positions: &mut UserPositions,
    markets: &Markets,
    market_to_close: Option<u64>,
) -> ClearingHouseResult<(u128, u128)> {
    let mut closed_position_base_asset_value: u128 = 0;
    let mut initial_margin_requirement: u128 = 0;
    let mut unrealized_pnl: i128 = 0;

    for market_position in user_positions.positions.iter() {
        if market_position.base_asset_amount == 0 {
            continue;
        }

        let market = markets.get_market(market_position.market_index);
        let amm = &market.amm;
        let (position_base_asset_value, position_unrealized_pnl) =
            calculate_base_asset_value_and_pnl(market_position, amm)?;

        if market_to_close.is_some() && market_to_close.unwrap() == market_position.market_index {
            closed_position_base_asset_value = position_base_asset_value;
        } else {
            initial_margin_requirement = initial_margin_requirement
                .checked_add(
                    position_base_asset_value
                        .checked_mul(market.margin_ratio_initial.into())
                        .ok_or_else(math_error!())?,
                )
                .ok_or_else(math_error!())?;
        }

        unrealized_pnl = unrealized_pnl
            .checked_add(position_unrealized_pnl)
            .ok_or_else(math_error!())?;
    }

    initial_margin_requirement = initial_margin_requirement
        .checked_div(MARGIN_PRECISION)
        .ok_or_else(math_error!())?;

    let total_collateral = calculate_updated_collateral(user.collateral, unrealized_pnl)?;

    let free_collateral = if initial_margin_requirement < total_collateral {
        total_collateral
            .checked_sub(initial_margin_requirement)
            .ok_or_else(math_error!())?
    } else {
        0
    };

    Ok((free_collateral, closed_position_base_asset_value))
}
