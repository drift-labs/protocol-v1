use crate::controller::position::{add_new_position, get_position_index};
use crate::error::ClearingHouseResult;
use crate::error::*;
use crate::math::casting::{cast, cast_to_i128, cast_to_u128};
use crate::math_error;
use crate::state::user_orders::Order;
use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::msg;
use std::cmp::min;

use crate::context::*;
use crate::error::*;
use crate::math::quote_asset::{asset_to_reserve_amount, reserve_to_asset_amount};
use crate::math::{amm, bn, constants::*, fees, margin::*, orders::*, position::*, withdrawal::*};
use crate::state::{
    history::order_history::{OrderHistory, OrderRecord},
    history::trade::{TradeHistory, TradeRecord},
    market::{Market, Markets, OracleSource, AMM},
    order_state::*,
    state::*,
    user::{MarketPosition, User, UserPositions},
    user_orders::*,
};
use controller::amm::SwapDirection;
use controller::position::PositionDirection;

use crate::controller;
use crate::math::fees::calculate_order_fee_tier;
use crate::optional_accounts::get_discount_token;
use crate::order_validation::validate_order;
use crate::state::history::funding_payment::FundingPaymentHistory;
use crate::state::history::funding_rate::FundingRateHistory;
use crate::state::history::order_history::OrderAction;
use std::cell::RefMut;

pub fn place_order(
    state: &State,
    order_state: &OrderState,
    user: &mut Box<Account<User>>,
    user_positions: &AccountLoader<UserPositions>,
    markets: &AccountLoader<Markets>,
    user_orders: &AccountLoader<UserOrders>,
    funding_payment_history: &AccountLoader<FundingPaymentHistory>,
    order_history: &AccountLoader<OrderHistory>,
    remaining_accounts: &[AccountInfo],
    clock: &Clock,
    order_type: OrderType,
    direction: PositionDirection,
    base_asset_amount: u128,
    price: u128,
    market_index: u64,
    reduce_only: bool,
    trigger_price: u128,
    trigger_condition: OrderTriggerCondition,
    optional_accounts: PlaceOrderOptionalAccounts,
) -> ProgramResult {
    let now = clock.unix_timestamp;

    let user_positions = &mut user_positions.load_mut()?;
    let funding_payment_history = &mut funding_payment_history.load_mut()?;
    controller::funding::settle_funding_payment(
        user,
        user_positions,
        &markets.load()?,
        funding_payment_history,
        now,
    )?;

    let user_orders = &mut user_orders.load_mut()?;
    let new_order_idx = user_orders
        .orders
        .iter()
        .position(|order| order.status.eq(&OrderStatus::Init))
        .ok_or(ErrorCode::MaxNumberOfOrders)?;
    let discount_token = get_discount_token(
        optional_accounts.discount_token,
        &mut remaining_accounts.iter(),
        &state.discount_mint,
        &user.authority.key(),
    )?;
    let discount_tier = calculate_order_fee_tier(&state.fee_structure, discount_token)?;
    let order_history_account = &mut order_history.load_mut()?;
    let order_id = order_history_account.next_order_id();
    let new_order = Order {
        status: OrderStatus::Open,
        order_type,
        ts: now,
        order_id,
        market_index,
        price,
        base_asset_amount,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        direction,
        reduce_only,
        discount_tier,
        trigger_price,
        trigger_condition,
    };

    {
        let markets = &markets.load()?;
        let market = markets.get_market(market_index);
        validate_order(&new_order, market, order_state)?;
    }

    user_orders.orders[new_order_idx] = new_order;

    // Increment open orders for existing position
    let position_index = get_position_index(user_positions, market_index)
        .or_else(|_| add_new_position(user_positions, market_index))?;
    let market_position = &mut user_positions.positions[position_index];
    market_position.open_orders += 1;

    // Add to the order history account
    let record_id = order_history_account.next_record_id();
    order_history_account.append(OrderRecord {
        ts: now,
        record_id,
        order: new_order,
        user: user.key(),
        authority: user.authority,
        action: OrderAction::Place,
        filler: Pubkey::default(),
        trade_record_id: 0,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        filler_reward: 0,
    });

    Ok(())
}

pub fn cancel_order(
    order_id: u128,
    user: &mut Box<Account<User>>,
    user_positions: &AccountLoader<UserPositions>,
    markets: &AccountLoader<Markets>,
    user_orders: &AccountLoader<UserOrders>,
    funding_payment_history: &AccountLoader<FundingPaymentHistory>,
    order_history: &AccountLoader<OrderHistory>,
    clock: &Clock,
) -> ProgramResult {
    let now = clock.unix_timestamp;

    let user_positions = &mut user_positions.load_mut()?;
    let funding_payment_history = &mut funding_payment_history.load_mut()?;
    controller::funding::settle_funding_payment(
        user,
        user_positions,
        &markets.load()?,
        funding_payment_history,
        now,
    )?;

    let user_orders = &mut user_orders.load_mut()?;
    let order_index = user_orders
        .orders
        .iter()
        .position(|order| order.order_id == order_id)
        .ok_or(ErrorCode::OrderDoesNotExist)?;
    let order = &mut user_orders.orders[order_index];

    if order.status != OrderStatus::Open {
        return Err(ErrorCode::OrderNotOpen.into());
    }

    // Add to the order history account
    let order_history_account = &mut order_history.load_mut()?;
    let record_id = order_history_account.next_record_id();
    order_history_account.append(OrderRecord {
        ts: now,
        record_id,
        order: *order,
        user: user.key(),
        authority: user.authority,
        action: OrderAction::Cancel,
        filler: Pubkey::default(),
        trade_record_id: 0,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        filler_reward: 0,
    });

    // Decrement open orders for existing position
    let position_index = get_position_index(user_positions, order.market_index)?;
    let market_position = &mut user_positions.positions[position_index];
    market_position.open_orders -= 1;
    *order = Order::default();

    Ok(())
}

pub fn fill_order(
    order_id: u128,
    state: &State,
    order_state: &OrderState,
    user: &mut Box<Account<User>>,
    user_positions: &AccountLoader<UserPositions>,
    markets: &AccountLoader<Markets>,
    oracle: &AccountInfo,
    user_orders: &AccountLoader<UserOrders>,
    filler: &mut Box<Account<User>>,
    funding_payment_history: &AccountLoader<FundingPaymentHistory>,
    trade_history: &AccountLoader<TradeHistory>,
    order_history: &AccountLoader<OrderHistory>,
    funding_rate_history: &AccountLoader<FundingRateHistory>,
    clock: &Clock,
) -> ProgramResult {
    let now = clock.unix_timestamp;
    let clock_slot = clock.slot;

    let user_positions = &mut user_positions.load_mut()?;
    let funding_payment_history = &mut funding_payment_history.load_mut()?;
    controller::funding::settle_funding_payment(
        user,
        user_positions,
        &markets.load()?,
        funding_payment_history,
        now,
    )?;

    let user_orders = &mut user_orders.load_mut()?;
    let order_index = user_orders
        .orders
        .iter()
        .position(|order| order.order_id == order_id)
        .ok_or(ErrorCode::OrderDoesNotExist)?;
    let order = &mut user_orders.orders[order_index];

    if order.status != OrderStatus::Open {
        return Err(ErrorCode::OrderNotOpen.into());
    }

    let market_index = order.market_index;
    {
        let markets = &markets.load()?;
        let market = markets.get_market(market_index);

        if !market.initialized {
            return Err(ErrorCode::MarketIndexNotInitialized.into());
        }

        if !market.amm.oracle.eq(&oracle.key) {
            return Err(ErrorCode::InvalidOracle.into());
        }
    }

    let mark_price_before: u128;
    let oracle_mark_spread_pct_before: i128;
    let is_oracle_valid: bool;
    {
        let markets = &mut markets.load_mut()?;
        let market = markets.get_market_mut(market_index);
        mark_price_before = market.amm.mark_price()?;
        let (oracle_price, _, _oracle_mark_spread_pct_before) =
            amm::calculate_oracle_mark_spread_pct(&market.amm, oracle, 0, clock_slot, None)?;
        oracle_mark_spread_pct_before = _oracle_mark_spread_pct_before;
        is_oracle_valid = amm::is_oracle_valid(
            &market.amm,
            oracle,
            clock_slot,
            &state.oracle_guard_rails.validity,
        )?;
        if is_oracle_valid {
            amm::update_oracle_price_twap(&mut market.amm, now, oracle_price)?;
        }
    }

    let (base_asset_amount, quote_asset_amount, potentially_risk_increasing) =
        execute_order_to_market(
            state,
            user,
            user_positions,
            order,
            &mut markets.load_mut()?,
            market_index,
            // market_position,
            mark_price_before,
            now,
        )?;

    let mark_price_after: u128;
    let oracle_price_after: i128;
    let oracle_mark_spread_pct_after: i128;
    {
        let markets = &mut markets.load_mut()?;
        let market = markets.get_market_mut(market_index);
        mark_price_after = market.amm.mark_price()?;
        let (_oracle_price_after, _oracle_mark_spread_after, _oracle_mark_spread_pct_after) =
            amm::calculate_oracle_mark_spread_pct(
                &market.amm,
                oracle,
                0,
                clock_slot,
                Some(mark_price_after),
            )?;
        oracle_price_after = _oracle_price_after;
        oracle_mark_spread_pct_after = _oracle_mark_spread_pct_after;
    }

    // Order fails if the trade is risk increasing and it pushes to mark price too far
    // away from the oracle price
    let is_oracle_mark_too_divergent = amm::is_oracle_mark_too_divergent(
        oracle_mark_spread_pct_after,
        &state.oracle_guard_rails.price_divergence,
    )?;
    if is_oracle_mark_too_divergent
        && oracle_mark_spread_pct_after.unsigned_abs()
            >= oracle_mark_spread_pct_before.unsigned_abs()
        && is_oracle_valid
        && potentially_risk_increasing
    {
        return Err(ErrorCode::OracleMarkSpreadLimit.into());
    }

    // Order fails if it's risk increasing and it brings the user below the initial margin ratio level
    let (
        _total_collateral_after,
        _unrealized_pnl_after,
        _base_asset_value_after,
        margin_ratio_after,
    ) = calculate_margin_ratio(user, user_positions, &markets.load()?)?;
    if margin_ratio_after < state.margin_ratio_initial && potentially_risk_increasing {
        return Err(ErrorCode::InsufficientCollateral.into());
    }

    let discount_tier = order.discount_tier;
    let (user_fee, fee_to_market, token_discount, filler_reward) =
        fees::calculate_fee_for_limit_order(
            quote_asset_amount,
            &state.fee_structure,
            &order_state.order_filler_reward_structure,
            &discount_tier,
            order.ts,
            now,
            filler.key() == user.key(),
        )?;

    // Increment the clearing house's total fee variables
    {
        let markets = &mut markets.load_mut()?;
        let market = markets.get_market_mut(market_index);
        market.amm.total_fee = market
            .amm
            .total_fee
            .checked_add(fee_to_market)
            .ok_or_else(math_error!())?;
        market.amm.total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_add(fee_to_market)
            .ok_or_else(math_error!())?;
    }

    // Subtract the fee from user's collateral
    user.collateral = user.collateral.checked_sub(user_fee).or(Some(0)).unwrap();

    // Increment the user's total fee variables
    user.total_fee_paid = user
        .total_fee_paid
        .checked_add(user_fee)
        .ok_or_else(math_error!())?;

    user.total_token_discount = user
        .total_token_discount
        .checked_add(token_discount)
        .ok_or_else(math_error!())?;

    filler.collateral = filler
        .collateral
        .checked_add(cast(filler_reward)?)
        .ok_or_else(math_error!())?;

    let trade_history_account = &mut trade_history.load_mut()?;
    let trade_record_id = trade_history_account.next_record_id();
    trade_history_account.append(TradeRecord {
        ts: now,
        record_id: trade_record_id,
        user_authority: user.authority,
        user: *user.to_account_info().key,
        direction: order.direction,
        base_asset_amount,
        quote_asset_amount,
        mark_price_before,
        mark_price_after,
        fee: user_fee,
        token_discount,
        referrer_reward: 0,
        referee_discount: 0,
        liquidation: false,
        market_index,
        oracle_price: oracle_price_after,
    });

    let order_history_account = &mut order_history.load_mut()?;
    let record_id = order_history_account.next_record_id();
    order_history_account.append(OrderRecord {
        ts: now,
        record_id,
        order: *order,
        user: user.key(),
        authority: user.authority,
        action: OrderAction::Fill,
        filler: filler.key(),
        trade_record_id,
        base_asset_amount_filled: base_asset_amount,
        quote_asset_amount_filled: quote_asset_amount,
        filler_reward,
    });

    // Cant reset order until after its been logged in order history
    if order.base_asset_amount == order.base_asset_amount_filled {
        *order = Order::default();
        let position_index = get_position_index(user_positions, market_index)?;
        let market_position = &mut user_positions.positions[position_index];
        market_position.open_orders -= 1;
    }

    // Try to update the funding rate at the end of every trade
    {
        let markets = &mut markets.load_mut()?;
        let market = markets.get_market_mut(market_index);
        let funding_rate_history = &mut funding_rate_history.load_mut()?;
        controller::funding::update_funding_rate(
            market_index,
            market,
            oracle,
            now,
            clock_slot,
            funding_rate_history,
            &state.oracle_guard_rails,
            state.funding_paused,
        )?;
    }

    Ok(())
}

pub fn execute_order_to_market(
    state: &State,
    user: &mut User,
    user_positions: &mut RefMut<UserPositions>,
    order: &mut Order,
    markets: &mut RefMut<Markets>,
    market_index: u64,
    mark_price_before: u128,
    now: i64,
) -> ClearingHouseResult<(u128, u128, bool)> {
    let max_leverage = MARGIN_PRECISION
        .checked_div(state.margin_ratio_initial)
        .ok_or_else(math_error!())?;
    let free_collateral = calculate_free_collateral(user, user_positions, markets, max_leverage)?;

    let position_index = get_position_index(user_positions, market_index)?;
    let market_position = &mut user_positions.positions[position_index];

    let market = markets.get_market_mut(market_index);
    let minimum_base_asset_trade_size = market.amm.minimum_base_asset_trade_size;

    let base_asset_amount: u128;
    {
        let order_swap_direction = match order.direction {
            PositionDirection::Long => SwapDirection::Add,
            PositionDirection::Short => SwapDirection::Remove,
        };

        let quote_asset_reserve_amount = asset_to_reserve_amount(
            free_collateral
                .checked_mul(max_leverage)
                .ok_or_else(math_error!())?,
            market.amm.peg_multiplier,
        )?;

        let initial_base_asset_amount = market.amm.base_asset_reserve;
        let (new_base_asset_amount, new_quote_asset_amount) = amm::calculate_swap_output(
            quote_asset_reserve_amount,
            market.amm.quote_asset_reserve,
            order_swap_direction,
            market.amm.sqrt_k,
        )?;

        let max_user_base_asset_amount = cast_to_i128(initial_base_asset_amount)?
            .checked_sub(cast(new_base_asset_amount)?)
            .ok_or_else(math_error!())?
            .unsigned_abs();

        let trade_base_asset_amount =
            calculate_base_asset_amount_to_trade(order, market, Some(mark_price_before))?;

        let proposed_base_asset_amount = min(max_user_base_asset_amount, trade_base_asset_amount);

        let base_asset_amount_left_to_fill = order
            .base_asset_amount
            .checked_sub(
                order
                    .base_asset_amount_filled
                    .checked_add(proposed_base_asset_amount)
                    .ok_or_else(math_error!())?,
            )
            .ok_or_else(math_error!())?;

        if base_asset_amount_left_to_fill > 0
            && base_asset_amount_left_to_fill < minimum_base_asset_trade_size
        {
            base_asset_amount = proposed_base_asset_amount
                .checked_add(base_asset_amount_left_to_fill)
                .ok_or_else(math_error!())?;
        } else {
            base_asset_amount = proposed_base_asset_amount;
        }
    }

    let (potentially_risk_increasing, quote_asset_amount) =
        controller::position::update_position_with_base_asset_amount(
            base_asset_amount,
            order.direction,
            market,
            user,
            market_position,
            now,
        )?;

    if potentially_risk_increasing && order.reduce_only {
        return Err(ErrorCode::ReduceOnlyOrderIncreasedRisk.into());
    }

    update_order_after_trade(
        order,
        minimum_base_asset_trade_size,
        base_asset_amount,
        quote_asset_amount,
    )?;

    Ok((
        base_asset_amount,
        quote_asset_amount,
        potentially_risk_increasing,
    ))
}

pub fn update_order_after_trade(
    order: &mut Order,
    minimum_base_asset_trade_size: u128,
    base_asset_amount: u128,
    quote_asset_amount: u128,
) -> ClearingHouseResult {
    order.base_asset_amount_filled = order
        .base_asset_amount_filled
        .checked_add(base_asset_amount)
        .ok_or_else(math_error!())?;

    order.quote_asset_amount_filled = order
        .quote_asset_amount_filled
        .checked_add(quote_asset_amount)
        .ok_or_else(math_error!())?;

    // redudancy test to make sure no min trade size remaining
    let base_asset_amount_to_fill = order
        .base_asset_amount
        .checked_sub(order.base_asset_amount_filled)
        .ok_or_else(math_error!())?;

    if base_asset_amount_to_fill > 0 && base_asset_amount_to_fill < minimum_base_asset_trade_size {
        return Err(ErrorCode::OrderAmountTooSmall.into());
    }

    Ok(())
}
