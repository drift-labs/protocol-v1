use crate::controller::position::{add_new_position, get_position_index};
use crate::error::ClearingHouseResult;
use crate::error::*;
use crate::math::casting::{cast, cast_to_i128, cast_to_u128};
use crate::math_error;
use crate::state::user_orders::Order;
use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::msg;
use std::cmp::{max, min};

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
use spl_token::state::Account as TokenAccount;
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
    discount_token: Option<TokenAccount>,
    referrer: &Option<Account<User>>,
    clock: &Clock,
    params: OrderParams,
) -> ClearingHouseResult {
    let now = clock.unix_timestamp;

    let user_positions = &mut user_positions
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
    let funding_payment_history = &mut funding_payment_history
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
    let markets = &markets
        .load()
        .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
    controller::funding::settle_funding_payment(
        user,
        user_positions,
        markets,
        funding_payment_history,
        now,
    )?;

    let user_orders = &mut user_orders
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
    let new_order_idx = user_orders
        .orders
        .iter()
        .position(|order| order.status.eq(&OrderStatus::Init))
        .ok_or(ErrorCode::MaxNumberOfOrders)?;
    let discount_tier = calculate_order_fee_tier(&state.fee_structure, discount_token)?;
    let order_history_account = &mut order_history
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
    let order_id = order_history_account.next_order_id();
    let new_order = Order {
        status: OrderStatus::Open,
        order_type: params.order_type,
        ts: now,
        order_id,
        market_index: params.market_index,
        price: params.price,
        base_asset_amount: params.base_asset_amount,
        quote_asset_amount: params.quote_asset_amount,
        base_asset_amount_filled: 0,
        quote_asset_amount_filled: 0,
        fee: 0,
        direction: params.direction,
        reduce_only: params.reduce_only,
        discount_tier,
        trigger_price: params.trigger_price,
        trigger_condition: params.trigger_condition,
        referrer: match referrer {
            Some(referrer) => referrer.key(),
            None => Pubkey::default(),
        },

        // always false until we add support
        post_only: false,
        immediate_or_cancel: false,
    };

    let market_index = params.market_index;

    // max quote asset allowable before a user would be partially liquidated 
    let allowable_quote_asset = calculate_available_quote_asset_user_can_execute(
        user,
        new_order.direction,
        get_position_index(user_positions, market_index)?,
        user_positions,
        markets,
        state.margin_ratio_partial,
    )?;

    let market = markets.get_market(market_index);
    validate_order(&new_order, market, order_state, allowable_quote_asset)?;

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
        fee: 0,
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
) -> ClearingHouseResult {
    let now = clock.unix_timestamp;

    let user_positions = &mut user_positions
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
    let funding_payment_history = &mut funding_payment_history
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
    let markets = &markets
        .load()
        .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
    controller::funding::settle_funding_payment(
        user,
        user_positions,
        markets,
        funding_payment_history,
        now,
    )?;

    let user_orders = &mut user_orders
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
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
    let order_history_account = &mut order_history
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
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
        fee: 0,
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
    referrer: Option<Account<User>>,
    clock: &Clock,
) -> ClearingHouseResult<(u128)> {
    let now = clock.unix_timestamp;
    let clock_slot = clock.slot;

    let user_positions = &mut user_positions
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
    let funding_payment_history = &mut funding_payment_history
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
    {
        let markets = &markets
            .load()
            .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
        controller::funding::settle_funding_payment(
            user,
            user_positions,
            markets,
            funding_payment_history,
            now,
        )?;
    }

    let user_orders = &mut user_orders
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
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
        let markets = &markets
            .load()
            .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
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
        let markets = &mut markets
            .load_mut()
            .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
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

    let (base_asset_amount, quote_asset_amount, potentially_risk_increasing) = execute_order(
        state,
        user,
        user_positions,
        order,
        &mut markets
            .load_mut()
            .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?,
        market_index,
        mark_price_before,
        now,
    )?;

    if base_asset_amount == 0 {
        return Ok(0);
    }

    let mark_price_after: u128;
    let oracle_price_after: i128;
    let oracle_mark_spread_pct_after: i128;
    {
        let markets = &mut markets
            .load_mut()
            .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
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
    ) = calculate_margin_ratio(
        user,
        user_positions,
        &markets
            .load()
            .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?,
    )?;
    if margin_ratio_after < state.margin_ratio_initial && potentially_risk_increasing {
        return Err(ErrorCode::InsufficientCollateral.into());
    }

    let discount_tier = order.discount_tier;
    let (user_fee, fee_to_market, token_discount, filler_reward, referrer_reward, referee_discount) =
        fees::calculate_fee_for_limit_order(
            quote_asset_amount,
            &state.fee_structure,
            &order_state.order_filler_reward_structure,
            &discount_tier,
            order.ts,
            now,
            &referrer,
            filler.key() == user.key(),
        )?;

    // Increment the clearing house's total fee variables
    {
        let markets = &mut markets
            .load_mut()
            .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
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
    user.total_referee_discount = user
        .total_referee_discount
        .checked_add(referee_discount)
        .ok_or_else(math_error!())?;

    filler.collateral = filler
        .collateral
        .checked_add(cast(filler_reward)?)
        .ok_or_else(math_error!())?;

    // Update the referrer's collateral with their reward
    if referrer.is_some() {
        let mut referrer = referrer.unwrap();
        referrer.total_referral_reward = referrer
            .total_referral_reward
            .checked_add(referrer_reward)
            .ok_or_else(math_error!())?;
        referrer
            .exit(&crate::ID)
            .or(Err(ErrorCode::UnableToWriteToRemainingAccount.into()))?;
    }

    {
        let markets = &mut markets
            .load()
            .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
        let market = markets.get_market(market_index);
        update_order_after_trade(
            order,
            market.amm.minimum_base_asset_trade_size,
            base_asset_amount,
            quote_asset_amount,
            user_fee,
        )?;
    }

    let trade_history_account = &mut trade_history
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
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
        referrer_reward,
        referee_discount,
        liquidation: false,
        market_index,
        oracle_price: oracle_price_after,
    });

    let order_history_account = &mut order_history
        .load_mut()
        .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
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
        fee: user_fee,
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
        let markets = &mut markets
            .load_mut()
            .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
        let market = markets.get_market_mut(market_index);
        let funding_rate_history = &mut funding_rate_history
            .load_mut()
            .or(Err(ErrorCode::UnableToLoadAccountLoader.into()))?;
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

    Ok(base_asset_amount)
}

pub fn execute_order(
    state: &State,
    user: &mut User,
    user_positions: &mut RefMut<UserPositions>,
    order: &mut Order,
    markets: &mut RefMut<Markets>,
    market_index: u64,
    mark_price_before: u128,
    now: i64,
) -> ClearingHouseResult<(u128, u128, bool)> {
    match order.order_type {
        OrderType::Market => execute_market_order(
            user,
            user_positions,
            order,
            markets,
            market_index,
            mark_price_before,
            now,
        ),
        _ => execute_non_market_order(
            state,
            user,
            user_positions,
            order,
            markets,
            market_index,
            mark_price_before,
            now,
        ),
    }
}

pub fn execute_market_order(
    user: &mut User,
    user_positions: &mut RefMut<UserPositions>,
    order: &mut Order,
    markets: &mut RefMut<Markets>,
    market_index: u64,
    mark_price_before: u128,
    now: i64,
) -> ClearingHouseResult<(u128, u128, bool)> {
    let position_index = get_position_index(user_positions, market_index)?;
    let market_position = &mut user_positions.positions[position_index];
    let market = markets.get_market_mut(market_index);

    let (potentially_risk_increasing, base_asset_amount, quote_asset_amount) =
        if order.base_asset_amount > 0 {
            controller::position::update_position_with_base_asset_amount(
                order.base_asset_amount,
                order.direction,
                market,
                user,
                market_position,
                now,
            )?
        } else {
            controller::position::update_position_with_quote_asset_amount(
                order.quote_asset_amount,
                order.direction,
                market,
                user,
                market_position,
                mark_price_before,
                now,
            )?
        };

    if potentially_risk_increasing && order.reduce_only {
        return Err(ErrorCode::ReduceOnlyOrderIncreasedRisk.into());
    }

    if order.price > 0 {
        if !limit_price_satisfied(
            order.price,
            quote_asset_amount,
            base_asset_amount,
            order.direction,
        )? {
            return Err(ErrorCode::SlippageOutsideLimit.into());
        }
    }

    Ok((
        base_asset_amount,
        quote_asset_amount,
        potentially_risk_increasing,
    ))
}

pub fn execute_non_market_order(
    state: &State,
    user: &mut User,
    user_positions: &mut RefMut<UserPositions>,
    order: &mut Order,
    markets: &mut RefMut<Markets>,
    market_index: u64,
    mark_price_before: u128,
    now: i64,
) -> ClearingHouseResult<(u128, u128, bool)> {
    // Determine the base asset amount the user can fill
    let base_asset_amount_user_can_execute = calculate_base_asset_amount_user_can_execute(
        state,
        user,
        user_positions,
        order,
        markets,
        market_index,
    )?;

    // Determine the base asset amount the market can fill
    let market = markets.get_market_mut(market_index);
    let base_asset_amount_market_can_execute =
        calculate_base_asset_amount_market_can_execute(order, market, Some(mark_price_before))?;

    let mut base_asset_amount = min(
        base_asset_amount_market_can_execute,
        base_asset_amount_user_can_execute,
    );

    let minimum_base_asset_trade_size = market.amm.minimum_base_asset_trade_size;
    let base_asset_amount_left_to_fill = order
        .base_asset_amount
        .checked_sub(
            order
                .base_asset_amount_filled
                .checked_add(base_asset_amount)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?;

    if base_asset_amount_left_to_fill > 0
        && base_asset_amount_left_to_fill < minimum_base_asset_trade_size
    {
        base_asset_amount = base_asset_amount
            .checked_add(base_asset_amount_left_to_fill)
            .ok_or_else(math_error!())?;
    }

    if base_asset_amount == 0 {
        return Ok((0, 0, false));
    }

    let position_index = get_position_index(user_positions, market_index)?;
    let market_position = &mut user_positions.positions[position_index];

    let (potentially_risk_increasing, _, quote_asset_amount) =
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
    fee: u128,
) -> ClearingHouseResult {
    order.base_asset_amount_filled = order
        .base_asset_amount_filled
        .checked_add(base_asset_amount)
        .ok_or_else(math_error!())?;

    order.quote_asset_amount_filled = order
        .quote_asset_amount_filled
        .checked_add(quote_asset_amount)
        .ok_or_else(math_error!())?;

    if order.order_type != OrderType::Market {
        // redundant test to make sure no min trade size remaining
        let base_asset_amount_to_fill = order
            .base_asset_amount
            .checked_sub(order.base_asset_amount_filled)
            .ok_or_else(math_error!())?;

        if base_asset_amount_to_fill > 0
            && base_asset_amount_to_fill < minimum_base_asset_trade_size
        {
            return Err(ErrorCode::OrderAmountTooSmall.into());
        }
    }

    order.fee = order.fee.checked_add(fee).ok_or_else(math_error!())?;

    Ok(())
}
