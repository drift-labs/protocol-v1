import * as anchor from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';
import { BN } from '../sdk/lib';
import csv from 'csvtojson';
import fs from 'fs';
import {
    Admin, 
	ClearingHouse,
	PositionDirection,
	ClearingHouseUser,
    OracleSource, 
    Market
} from '../sdk/src';
import * as drift from '../sdk/src'

import { mockUserUSDCAccount, mockUSDCMint } from './mockAccounts';
import { mockOracle } from './mockAccounts';
import { getFeedData, setFeedPrice } from './mockPythUtils';
import { initUserAccount } from './stressUtils'

import * as web3 from '@solana/web3.js'
var assert = require('assert');

export function save_states_to_csv(market_states, filename) {
    // save to csv 
    let df_rows = {}
    // derive all column names 
    let df_columns = []
    for (let state of market_states) {
        for (const [key, _] of Object.entries(state)) {
            if (!df_columns.includes(key)) { 
                df_columns.push(key)
                df_rows[key] = []
            }
        }
    }

    // add row data to df 
    for (let state of market_states) {
        for (let column of df_columns) {
            if (column in state) { 
                let v = state[column]
                df_rows[column].push(v)
            } else { 
                df_rows[column].push("NaN") // empty 
            }
        }
    }

    // rows => string 
    let csv_string = ""
    // add header 
    csv_string += df_columns.join(",") + "\n"
    // add rows 
    for (let i=0; i < df_rows[df_columns[0]].length; i++) {
        let row_string = ""
        for (let column of df_columns) {
            row_string += df_rows[column][i] + ","
        }
        csv_string += row_string + "\n"
    }
    fs.writeFileSync(
        filename,
        csv_string,
    )
}

export async function serialize_user_and_positions(user, user_index) {
    let user_kp = user['user_kp'] as web3.Keypair
    let user_ch = user['user_ch'] as ClearingHouse
    let user_uch = user['user_uch'] as ClearingHouseUser

    // serialize things 
    let user_acc = await user_ch.getUserAccount()
    let user_json = serialize_user(user_acc)
    user_json = rename(user_json, `u${user_index}_`)

    let free_collateral = await user_uch.getFreeCollateral()
    let margin_ratio = await user_uch.getMarginRatio()
    let total_position_value = await user_uch.getTotalPositionValue()

    // position 
    let json_all_positions = []
    let user_positions = (await user_uch.getUserPositionsAccount()).positions
    for (let i = 0; i < user_positions.length; i++) {
        let position = user_positions[i] as drift.UserPosition
        if (!position.baseAssetAmount.eq(new BN(0))) {
            let position_midx = position.marketIndex.toString()
            let json_position = serialize_position(position)
            json_position = rename(json_position, `m${position_midx}_`)
            json_all_positions.push(json_position)
        }
    }

    let all_positions = Object.assign({}, ...json_all_positions)
    all_positions["free_collateral"] = free_collateral.toString()
    all_positions["margin_ratio"] = margin_ratio.toString()
    all_positions["total_position_value"] = total_position_value.toString()
    all_positions = rename(all_positions, `u${user_index}_`)

    let json_user = Object.assign({}, all_positions, user_json)
    return json_user
}

var rename = function(obj, prefix){

    if(typeof obj !== 'object' || !obj){
        return false;    // check the obj argument somehow
    }

    var keys = Object.keys(obj),
        keysLen = keys.length,
        prefix = prefix || '';

    for(var i=0; i<keysLen ;i++){

        obj[prefix+keys[i]] = obj[keys[i]];
        if(typeof obj[keys[i]]=== 'object'){
            rename(obj[prefix+keys[i]],prefix);
        }
        delete obj[keys[i]];
    }

    return obj;
};

export function serialize_position(position: any) {
    let result = {
        market_index: position.marketIndex.toString(),
        base_asset_amount: position.baseAssetAmount.toString(),
        quote_asset_amount: position.quoteAssetAmount.toString(),
        last_cumulative_funding_rate: position.lastCumulativeFundingRate.toString(),
        last_cumulative_repeg_rebate: position.lastCumulativeRepegRebate.toString(),
        last_funding_rate_ts: position.lastFundingRateTs.toString(),
        open_orders: position.openOrders.toString(),
    }
    return result 
}

export function serialize_user(user: drift.UserAccount) {
    let user_json ={
        collateral: user.collateral.toString(),
        cumulative_deposits: user.cumulativeDeposits.toString(),
        total_fee_paid: user.totalFeePaid.toString(),
        total_fee_rebate: user.totalFeeRebate.toString(),
        total_token_discount: user.totalTokenDiscount.toString(),
        total_referral_reward: user.totalReferralReward.toString(),
        total_referee_discount: user.totalRefereeDiscount.toString(),
        settled_position_value: user.settledPositionValue.toString(),
        collateral_claimed: user.collateralClaimed.toString(),
        last_collateral_available_to_claim: user.lastCollateralAvailableToClaim.toString(),
        forgo_position_settlement: user.forgoPositionSettlement.toString(),
        has_settled_position: user.hasSettledPosition.toString(),
    }
    return user_json
}

export function serialize_market(market: Market) {
    let market_json =  {
        initialized: market.initialized.toString(),
        base_asset_amount_long: market.baseAssetAmountLong.toString(),
        base_asset_amount_short: market.baseAssetAmountShort.toString(),
        base_asset_amount: market.baseAssetAmount.toString(),
        open_interest: market.openInterest.toString(),
        base_asset_reserve: market.amm.baseAssetReserve.toString(),
        quote_asset_reserve: market.amm.quoteAssetReserve.toString(),
        cumulative_repeg_rebate_long: market.amm.cumulativeRepegRebateLong.toString(),
        cumulative_repeg_rebate_short: market.amm.cumulativeRepegRebateShort.toString(),
        cumulative_funding_rate_long: market.amm.cumulativeFundingRateLong.toString(),
        cumulative_funding_rate_short: market.amm.cumulativeFundingRateShort.toString(),
        last_funding_rate: market.amm.lastFundingRate.toString(),
        last_funding_rate_ts: market.amm.lastFundingRateTs.toString(),
        funding_period: market.amm.fundingPeriod.toString(),
        last_oracle_price_twap: market.amm.lastOraclePriceTwap.toString(),
        last_mark_price_twap: market.amm.lastMarkPriceTwap.toString(),
        last_mark_price_twap_ts: market.amm.lastMarkPriceTwapTs.toString(),
        sqrt_k: market.amm.sqrtK.toString(),
        peg_multiplier: market.amm.pegMultiplier.toString(),
        total_fee: market.amm.totalFee.toString(),
        total_fee_minus_distributions: market.amm.totalFeeMinusDistributions.toString(),
        total_fee_withdrawn: market.amm.totalFeeWithdrawn.toString(),
        minimum_quote_asset_trade_size: market.amm.minimumQuoteAssetTradeSize.toString(),
        last_oracle_price_twap_ts: market.amm.lastOraclePriceTwapTs.toString(),
        last_oracle_price: market.amm.lastOraclePrice.toString(),
        minimum_base_asset_trade_size: market.amm.minimumBaseAssetTradeSize.toString(),
        base_spread: market.amm.baseSpread.toString(),
        margin_ratio_initial: market.marginRatioInitial.toString(),
        margin_ratio_partial: market.marginRatioPartial.toString(),
        margin_ratio_maintenance: market.marginRatioMaintenance.toString(),
    }
    return market_json
}
