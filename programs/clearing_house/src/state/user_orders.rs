use crate::controller::position::PositionDirection;
use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};

#[account(zero_copy)]
pub struct UserOrders {
    pub user: Pubkey,
    pub orders: [Order; 20],
}

impl Default for UserOrders {
    fn default() -> Self {
        return Self {
            user: Pubkey::default(),
            orders: [Order::default(); 20],
        };
    }
}

impl UserOrders {
    pub fn index_from_u64(index: u64) -> usize {
        return std::convert::TryInto::try_into(index).unwrap();
    }
}

#[zero_copy]
pub struct Order {
    pub status: OrderStatus,
    pub order_type: OrderType,
    pub ts: i64,
    pub order_id: u128,
    pub market_index: u64,
    pub price: u128,
    pub quote_asset_amount: u128,
    pub base_asset_amount: u128,
    pub base_asset_amount_filled: u128,
    pub quote_asset_amount_filled: u128,
    pub fee: u128,
    pub direction: PositionDirection,
    pub reduce_only: bool,
    pub post_only: bool,
    pub immediate_or_cancel: bool,
    pub discount_tier: OrderDiscountTier,
    pub trigger_price: u128,
    pub trigger_condition: OrderTriggerCondition,
    pub referrer: Pubkey,
    pub padding: [u16; 3],
}

impl Default for Order {
    fn default() -> Self {
        return Self {
            status: OrderStatus::Init,
            order_type: OrderType::Limit,
            ts: 0,
            order_id: 0,
            market_index: 0,
            price: 0,
            base_asset_amount: 0,
            quote_asset_amount: 0,
            base_asset_amount_filled: 0,
            quote_asset_amount_filled: 0,
            fee: 0,
            direction: PositionDirection::Long,
            reduce_only: false,
            post_only: false,
            immediate_or_cancel: false,
            discount_tier: OrderDiscountTier::None,
            trigger_price: 0,
            trigger_condition: OrderTriggerCondition::Above,
            referrer: Pubkey::default(),
            padding: [0; 3],
        };
    }
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
pub enum OrderStatus {
    Init,
    Open,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
pub enum OrderType {
    Market,
    Limit,
    Stop,
    StopLimit,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
pub enum OrderDiscountTier {
    None,
    First,
    Second,
    Third,
    Fourth,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
pub enum OrderTriggerCondition {
    Above,
    Below,
}

impl Default for OrderTriggerCondition {
    // UpOnly
    fn default() -> Self {
        OrderTriggerCondition::Above
    }
}
