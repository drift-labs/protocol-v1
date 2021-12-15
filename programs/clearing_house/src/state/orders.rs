use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use crate::controller::position::PositionDirection;

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
    pub market_index: u64,
    pub price: u128,
    pub base_asset_amount: u128,
    pub base_asset_amount_filled: u128,
    pub direction: PositionDirection,
    pub reduce_only: bool,
    pub discount_tier: OrderDiscountTier,
}

impl Default for Order {
    fn default() -> Self {
        return Self {
            status: OrderStatus::Init,
            market_index: 0,
            price: 0,
            base_asset_amount: 0,
            base_asset_amount_filled: 0,
            direction: PositionDirection::Long,
            reduce_only: false,
            discount_tier: OrderDiscountTier::None,
        };
    }
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
pub enum  OrderStatus {
    Init,
    Open,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
pub enum  OrderType {
    Limit,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
pub enum  OrderDiscountTier {
    None,
    First,
    Second,
    Third,
    Fourth
}


