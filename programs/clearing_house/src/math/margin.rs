use crate::error::*;
use crate::math::collateral::calculate_updated_collateral;
use crate::math::constants::{
    AMM_TO_QUOTE_PRECISION_RATIO, MARGIN_PRECISION, MARK_PRICE_PRECISION,
};
use crate::math::position::calculate_base_asset_value_and_pnl;
use crate::math_error;
use crate::state::market::Markets;
use crate::state::user::{User, UserPositions};
use std::cell::{Ref, RefMut};

use crate::math::oracle::{get_oracle_status, OracleStatus};
use crate::state::state::OracleGuardRails;
use anchor_lang::prelude::AccountInfo;
use solana_program::clock::Slot;
use solana_program::msg;
use std::convert::TryInto;
use std::ops::Div;

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
    pub margin_requirement: u128,
    pub total_collateral: u128,
    pub unrealized_pnl: i128,
    pub base_asset_value: u128,
    pub market_statuses: [MarketStatus; 5],
    pub number_of_open_positions: u8,
}

#[derive(Default, Clone, Copy, Debug)]
pub struct MarketStatus {
    pub market_index: u64,
    pub partial_margin_requirement: u128,
    pub maintenance_margin_requirement: u128,
    pub base_asset_value: u128,
    pub mark_price_before: u128,
    pub oracle_status: OracleStatus,
}

pub fn calculate_liquidation_status(
    user: &User,
    user_positions: &RefMut<UserPositions>,
    markets: &Ref<Markets>,
    remaining_accounts: &[AccountInfo],
    oracle_guard_rails: &OracleGuardRails,
    clock_slot: Slot,
) -> ClearingHouseResult<LiquidationStatus> {
    let mut partial_margin_requirement: u128 = 0;
    let mut maintenance_margin_requirement: u128 = 0;
    let mut base_asset_value: u128 = 0;
    let mut unrealized_pnl: i128 = 0;
    let mut number_of_open_positions = 0_u8;
    let mut market_statuses = [MarketStatus::default(); 5];
    let mut can_use_oracle_margin_calculation = true;
    let mut oracle_partial_margin_requirement: u128 = 0;
    let mut oracle_maintenance_margin_requirement: u128 = 0;

    for (i, market_position) in user_positions.positions.iter().enumerate() {
        if market_position.base_asset_amount == 0 {
            continue;
        }
        number_of_open_positions += 1; // can only be five

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

        let market_partial_margin_requirement = (position_base_asset_value)
            .checked_mul(market.margin_ratio_partial.into())
            .ok_or_else(math_error!())?;

        partial_margin_requirement = partial_margin_requirement
            .checked_add(market_partial_margin_requirement)
            .ok_or_else(math_error!())?;

        let market_maintenance_margin_requirement = position_base_asset_value
            .checked_mul(market.margin_ratio_maintenance.into())
            .ok_or_else(math_error!())?;

        maintenance_margin_requirement = maintenance_margin_requirement
            .checked_add(market_maintenance_margin_requirement)
            .ok_or_else(math_error!())?;

        // Block the liquidation if the oracle is invalid or the oracle and mark are too divergent
        let oracle_account_info = remaining_accounts
            .iter()
            .find(|account_info| account_info.key.eq(&market.amm.oracle))
            .ok_or(ErrorCode::OracleNotFound)?;

        let mark_price_before = market.amm.mark_price()?;

        let oracle_status = get_oracle_status(
            &market.amm,
            oracle_account_info,
            clock_slot,
            oracle_guard_rails,
            Some(mark_price_before),
        )?;

        if oracle_status.is_valid && oracle_status.price >= 0 {
            let oracle_position_base_asset_value = market_position
                .base_asset_amount
                .unsigned_abs()
                .checked_mul(oracle_status.price.unsigned_abs())
                .ok_or_else(math_error!())?
                .div(MARK_PRICE_PRECISION)
                .div(AMM_TO_QUOTE_PRECISION_RATIO);

            let market_partial_margin_requirement = (oracle_position_base_asset_value)
                .checked_mul(market.margin_ratio_partial.into())
                .ok_or_else(math_error!())?;

            oracle_partial_margin_requirement = partial_margin_requirement
                .checked_add(market_partial_margin_requirement)
                .ok_or_else(math_error!())?;

            let market_maintenance_margin_requirement = oracle_position_base_asset_value
                .checked_mul(market.margin_ratio_maintenance.into())
                .ok_or_else(math_error!())?;

            oracle_maintenance_margin_requirement = maintenance_margin_requirement
                .checked_add(market_maintenance_margin_requirement)
                .ok_or_else(math_error!())?;
        } else {
            can_use_oracle_margin_calculation = false;
        }

        market_statuses[i] = MarketStatus {
            market_index: market_position.market_index,
            partial_margin_requirement: market_partial_margin_requirement.div(MARGIN_PRECISION),
            maintenance_margin_requirement: market_maintenance_margin_requirement
                .div(MARGIN_PRECISION),
            base_asset_value: position_base_asset_value,
            mark_price_before,
            oracle_status,
        };
    }

    partial_margin_requirement = partial_margin_requirement
        .checked_div(MARGIN_PRECISION)
        .ok_or_else(math_error!())?;

    maintenance_margin_requirement = maintenance_margin_requirement
        .checked_div(MARGIN_PRECISION)
        .ok_or_else(math_error!())?;

    oracle_partial_margin_requirement = oracle_partial_margin_requirement
        .checked_div(MARGIN_PRECISION)
        .ok_or_else(math_error!())?;

    oracle_maintenance_margin_requirement = oracle_maintenance_margin_requirement
        .checked_div(MARGIN_PRECISION)
        .ok_or_else(math_error!())?;

    let total_collateral = calculate_updated_collateral(user.collateral, unrealized_pnl)?;

    let requires_partial_liquidation: bool;
    let requires_full_liquidation: bool;
    if can_use_oracle_margin_calculation {
        let amm_requires_partial_liquidation = total_collateral < partial_margin_requirement;
        let oracle_requires_partial_liquidation =
            total_collateral < oracle_partial_margin_requirement;
        msg!(
            "oracle_requires_partial_liquidation {}",
            oracle_requires_partial_liquidation
        );
        requires_partial_liquidation =
            amm_requires_partial_liquidation && oracle_requires_partial_liquidation;

        let amm_requires_full_liquidation = total_collateral < maintenance_margin_requirement;
        let oracle_requires_full_liquidation =
            total_collateral < oracle_maintenance_margin_requirement;
        msg!(
            "oracle_requires_full_liquidation {}",
            oracle_requires_full_liquidation
        );
        requires_full_liquidation =
            amm_requires_full_liquidation && oracle_requires_full_liquidation;
    } else {
        msg!(
            "can_use_oracle_margin_calculation {}",
            can_use_oracle_margin_calculation
        );
        requires_partial_liquidation = total_collateral < partial_margin_requirement;
        requires_full_liquidation = total_collateral < maintenance_margin_requirement;
    }

    let liquidation_type = if requires_full_liquidation {
        LiquidationType::FULL
    } else if requires_partial_liquidation {
        LiquidationType::PARTIAL
    } else {
        LiquidationType::NONE
    };

    let margin_requirement = match liquidation_type {
        LiquidationType::FULL => maintenance_margin_requirement,
        LiquidationType::PARTIAL => partial_margin_requirement,
        LiquidationType::NONE => 0,
    };

    // Sort the market statuses such that we close the markets with biggest margin requirements first
    if liquidation_type == LiquidationType::FULL {
        market_statuses.sort_by(|a, b| {
            b.maintenance_margin_requirement
                .cmp(&a.maintenance_margin_requirement)
        });
    } else if liquidation_type == LiquidationType::PARTIAL {
        market_statuses.sort_by(|a, b| {
            b.partial_margin_requirement
                .cmp(&a.partial_margin_requirement)
        });
    }

    Ok(LiquidationStatus {
        liquidation_type,
        margin_requirement,
        total_collateral,
        unrealized_pnl,
        base_asset_value,
        market_statuses,
        number_of_open_positions,
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
