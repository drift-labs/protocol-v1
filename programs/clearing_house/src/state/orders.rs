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

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize)]
pub enum  Order {
    Limit {
        market_index: u64,
        price: u128,
        base_asset_amount: u128,
    },
}

impl Default for Order {
    fn default() -> Self {
        return Self::Limit {
            market_index: 0,
            price: 0,
            base_asset_amount: 0
        };
    }
}





