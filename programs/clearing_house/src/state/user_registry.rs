use anchor_lang::prelude::*;

pub const UNINITIALIZED_NAME: [u8; 32] = [32; 32];

#[account]
#[derive(Default)]
pub struct UserRegistry {
    pub authority: Pubkey,
    pub names: [[u8; 32]; 16],
}

impl UserRegistry {
    pub fn is_seed_taken(&self, seed: u8) -> bool {
        self.names[seed as usize] != UNINITIALIZED_NAME
    }

    pub fn next_available_seed(&self) -> Option<u8> {
        self.names
            .iter()
            .position(|name| *name == UNINITIALIZED_NAME)
            .map(|seed| seed as u8)
    }
}

pub fn is_valid_name(name: [u8; 32]) -> bool {
    name != UNINITIALIZED_NAME
}
