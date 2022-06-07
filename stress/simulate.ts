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
	Market,
} from '../sdk/src';
import * as drift from '../sdk/src';

import { mockUserUSDCAccount, mockUSDCMint } from './mockAccounts';
import { mockOracle } from './mockAccounts';
import { getFeedData, setFeedPrice, setFeedPriceDirect } from './mockPythUtils';
import { initUserAccount } from './stressUtils';

import * as web3 from '@solana/web3.js';
var assert = require('assert');

import { argv } from 'node:process';

import {
	serialize_user_and_positions,
	serialize_position,
	serialize_user,
	serialize_market,
} from './simulate_utils';

async function main() {
	// extract simulation path from cli args
	let simulationPath = '';
	for (let i = 0; i < argv.length; i++) {
		let arg = argv[i];
		if (arg.includes('--simulation-path=')) {
			simulationPath = arg.split('=')[1];
		}
	}
	assert(simulationPath != '', '--simulation-path=<path> must be specified');
	console.log('simulation path:', simulationPath);

	// start local validator + load local programs upon startup
	var provider = anchor.AnchorProvider.local();
	var connection = provider.connection;
	anchor.setProvider(provider);

	const chProgram = anchor.workspace.ClearingHouse as anchor.Program;
	const pyProgram = anchor.workspace.Pyth as anchor.Program;

	// setup
	const usdcMint = await mockUSDCMint(provider);
	const clearingHouse = Admin.from(
		connection,
		provider.wallet,
		chProgram.programId
	);

	// init ch program
	await clearingHouse.initialize(usdcMint.publicKey, true);
	await clearingHouse.subscribe();

	// read csv files to simulate off of
	const events = await csv().fromFile(simulationPath + '/events.csv');
	const ch_states = await csv().fromFile(
		simulationPath + '/simulation_state.csv'
	);
	const oracle_prices = await csv().fromFile(
		simulationPath + '/all_oracle_prices.csv'
	);

	// init oracle
	let ORACLE_PRECISION = 10; // 1e10
	let init_oracle_price = new BN(parseInt(oracle_prices[0]['price']));
	let solUsd = await mockOracle(init_oracle_price, -ORACLE_PRECISION);

	// init clearing house market
	let marketIndex = new anchor.BN(0);
	var init_ch_state = ch_states[0];
	console.log(init_ch_state);
	const baseR = init_ch_state['m0_base_asset_reserve'];
	const quoteR = init_ch_state['m0_quote_asset_reserve'];
	await clearingHouse.initializeMarket(
		marketIndex,
		solUsd,
		new anchor.BN(baseR),
		new anchor.BN(quoteR),
		new anchor.BN(parseInt(init_ch_state['m0_funding_period'])),
		new anchor.BN(parseInt(init_ch_state['m0_peg_multiplier'])),
		OracleSource.PYTH,
		init_ch_state['m0_margin_ratio_initial'],
		init_ch_state['m0_margin_ratio_partial'],
		init_ch_state['m0_margin_ratio_maintenance']
	);

	// run through each event
	let users = {};
	let market_state = [];

	for (let i = 0; i < events.length; i++) {
		let event = events[i];
		let timestamp = parseInt(event['timestamp']);
		let event_name = event['event_name'];
		console.log(`${i}/${events.length}:`, 'event:', event_name);

		if (event_name != 'null') {
			// set oracle price at timestep t
			let oracle_price_t = oracle_prices.find(
				(or) => or.timestamp == timestamp
			)['price'];

			await setFeedPriceDirect(
				pyProgram,
				new anchor.BN(oracle_price_t),
				solUsd
			);
		}

		// process the event
		if (event_name == 'deposit_collateral') {
			let parameters = JSON.parse(event['parameters']);
			let user_index = parameters['user_index'];
			let deposit_amount = new anchor.BN(parameters['deposit_amount']);

			if (!(user_index in users)) {
				var result = await initUserAccount(
					usdcMint,
					new anchor.BN(deposit_amount),
					provider
				);
				let user_kp = result[0] as web3.Keypair;
				let user_ch = result[1] as ClearingHouse;
				let user_uch = result[2] as ClearingHouseUser;

				users[user_index] = {
					user_kp: user_kp,
					user_ch: user_ch,
					user_uch: user_uch,
				};
			} else {
				throw Error('re-deposits not supported yet...');
			}
		} else if (event_name == 'open_position') {
			let parameters = JSON.parse(event['parameters']);
			console.log(parameters);

			let user_index = parameters['user_index'];
			let quote_amount = parameters['quote_amount'];
			let direction =
				parameters['direction'] == 'long'
					? PositionDirection.LONG
					: PositionDirection.SHORT;
			assert(
				parameters['direction'] == 'long' || parameters['direction'] == 'short'
			);
			let market_index = parameters['market_index'];
			assert(market_index == 0, 'only support market 0');

			let user = users[user_index];
			let user_ch: ClearingHouse = user['user_ch'];
			await user_ch.openPosition(
				direction,
				new anchor.BN(quote_amount),
				new anchor.BN(market_index)
			);
		} else if (event_name == 'null') {
			// do nothing
		} else {
			throw Error('not supported yet...');
		}

		// serialize the full state
		let all_user_jsons = [];
		for (const [user_index, user] of Object.entries(users)) {
			let user_json = await serialize_user_and_positions(user, user_index);
			all_user_jsons.push(user_json);
		}
		all_user_jsons = Object.assign({}, ...all_user_jsons);

		let market = clearingHouse.getMarket(marketIndex);
		let market_json = serialize_market(market, marketIndex.toNumber());

		let state = Object.assign({}, market_json, all_user_jsons);
		state['timestamp'] = timestamp;
		market_state.push(state);
	}

	fs.writeFileSync('simulation.csv', JSON.stringify(market_state));

	console.log('done!');
}

main();
