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

#[zero_copy]
pub struct Order {
    pub status: OrderStatus,
    pub market_index: u64,
    pub price: u128,
    pub base_asset_amount: u128,
    pub direction: PositionDirection,
}

impl Default for Order {
    fn default() -> Self {
        return Self {
            status: OrderStatus::Init,
            market_index: 0,
            price: 0,
            base_asset_amount: 0,
            direction: PositionDirection::Long,
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





