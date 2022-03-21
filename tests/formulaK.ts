import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN, FUNDING_PAYMENT_PRECISION } from '../sdk';

import { Keypair } from '@solana/web3.js';
import { Program } from '@project-serum/anchor';
import {
	Admin,
	MARK_PRICE_PRECISION,
	calculateMarkPrice,
	ClearingHouseUser,
	PEG_PRECISION,
	PositionDirection,
	convertToNumber,
} from '../sdk/src';

import { Markets } from '../sdk/src/constants/markets';

import {
	createPriceFeed,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	getFeedData,
} from './testHelpers';
import { QUOTE_PRECISION } from '../sdk/lib';

const ZERO = new BN(0);

describe('formulaic curve (repeg / k)', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;
	const initialSOLPrice = 150;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const usdcAmount = new BN(1e9 * 10 ** 6);

	let userAccount: ClearingHouseUser;
	let solUsdOracle;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId
		);
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		const periodicity = new BN(0); // 1 HOUR

		solUsdOracle = await createPriceFeed({
			oracleProgram: anchor.workspace.Pyth,
			initPrice: initialSOLPrice,
		});

		await clearingHouse.initializeMarket(
			Markets[0].marketIndex,
			solUsdOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(initialSOLPrice * PEG_PRECISION.toNumber())
		);

		await clearingHouse.initializeUserAccount();
		userAccount = ClearingHouseUser.from(
			clearingHouse,
			provider.wallet.publicKey
		);
		await userAccount.subscribe();
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await userAccount.unsubscribe();
	});

	it('track netRevenueSinceLastFunding', async () => {
		await clearingHouse.depositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const marketIndex = Markets[0].marketIndex;

		const targetPriceBack = new BN(
			initialSOLPrice * MARK_PRICE_PRECISION.toNumber()
		);

		// const [direction, tradeSize, _] = clearingHouse.calculateTargetPriceTrade(
		// 	marketIndex,
		// 	targetPriceUp
		// );
		await clearingHouse.moveAmmToPrice(marketIndex, targetPriceBack);
		await clearingHouse.updateFundingPaused(true);

		console.log('taking position');
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			new BN(1000).mul(QUOTE_PRECISION),
			marketIndex
		);
		console.log('$1000 position taken');
		await clearingHouse.fetchAccounts();
		const marketsOld = await clearingHouse.getMarketsAccount();
		assert(!marketsOld.markets[0].baseAssetAmount.eq(ZERO));

		const oldKPrice = calculateMarkPrice(clearingHouse.getMarket(marketIndex));
		const ammOld = marketsOld.markets[0].amm;
		console.log(
			'USER getTotalCollateral',
			convertToNumber(userAccount.getTotalCollateral(), QUOTE_PRECISION)
		);

		await clearingHouse.fetchAccounts();
		const marketsKChange = await clearingHouse.getMarketsAccount();
		const ammKChange = marketsKChange.markets[0].amm;

		const newKPrice = calculateMarkPrice(clearingHouse.getMarket(marketIndex));

		console.log('$1000 position closing');

		await clearingHouse.closePosition(marketIndex);
		console.log('$1000 position closed');

		const markets = await clearingHouse.getMarketsAccount();

		const amm = markets.markets[0].amm;

		const marginOfError = new BN(MARK_PRICE_PRECISION.div(new BN(1000))); // price change less than 3 decimal places

		// console.log(
		// 	'oldSqrtK',
		// 	convertToNumber(ammOld.sqrtK),
		// 	'oldKPrice:',
		// 	convertToNumber(oldKPrice)
		// );
		// console.log(
		// 	'newSqrtK',
		// 	convertToNumber(newSqrtK),
		// 	'newKPrice:',
		// 	convertToNumber(newKPrice)
		// );

		// assert(ammOld.sqrtK.eq(amm.sqrtK));
		// assert(newKPrice.sub(oldKPrice).abs().lt(marginOfError));
		// assert(!amm.sqrtK.eq(newSqrtK));

		console.log(
			'realizedFeeOld',
			convertToNumber(ammOld.totalFeeMinusDistributions, QUOTE_PRECISION),
			'realizedFeePostK',
			convertToNumber(ammKChange.totalFeeMinusDistributions, QUOTE_PRECISION),
			'realizedFeePostClose',
			convertToNumber(amm.totalFeeMinusDistributions, QUOTE_PRECISION),
			'netRevenue',
			convertToNumber(amm.netRevenueSinceLastFunding, QUOTE_PRECISION)
		);

		assert(amm.netRevenueSinceLastFunding.eq(amm.totalFeeMinusDistributions));
		console.log(
			'USER getTotalCollateral',
			convertToNumber(userAccount.getTotalCollateral(), QUOTE_PRECISION)
		);
	});
	it('update funding (netRevenueSinceLastFunding)', async () => {
		const marketIndex = Markets[0].marketIndex;
		await clearingHouse.updateFundingPaused(false);
		await new Promise((r) => setTimeout(r, 1000)); // wait 1 second

		const _tx = await clearingHouse.updateFundingRate(
			solUsdOracle,
			marketIndex
		);
		await new Promise((r) => setTimeout(r, 1000)); // wait 1 second

		const markets = await clearingHouse.getMarketsAccount();
		const market = markets.markets[0];
		const amm = market.amm;

		// await setFeedPrice(program, newPrice, priceFeedAddress);
		const oraclePx = await getFeedData(anchor.workspace.Pyth, amm.oracle);

		console.log(
			'markPrice:',
			convertToNumber(calculateMarkPrice(market)),
			'oraclePrice:',
			oraclePx.p
		);
		console.log(
			'USER getTotalCollateral',
			convertToNumber(userAccount.getTotalCollateral(), QUOTE_PRECISION),
			'fundingPnL:',
			convertToNumber(userAccount.getUnrealizedFundingPNL(), QUOTE_PRECISION)
		);
		console.log(
			'fundingRate:',
			convertToNumber(amm.lastFundingRate, MARK_PRICE_PRECISION)
		);
		console.log(
			'realizedFeePostClose',
			convertToNumber(amm.totalFeeMinusDistributions, QUOTE_PRECISION),
			'netRevenue',
			convertToNumber(amm.netRevenueSinceLastFunding, QUOTE_PRECISION)
		);

		assert(amm.netRevenueSinceLastFunding.eq(ZERO));
	});
});
