import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { Keypair } from '@solana/web3.js';
import { Program } from '@project-serum/anchor';
import {
	BN,
	FUNDING_PAYMENT_PRECISION,
	Admin,
	MARK_PRICE_PRECISION,
	calculateMarkPrice,
	ClearingHouseUser,
	PEG_PRECISION,
	PositionDirection,
	calculateBudgetedPeg,
	calculateBudgetedK,
	// OrderStatus,
	// OrderDiscountTier,
	// OrderRecord,
	// OrderAction,
	// OrderTriggerCondition,
	// calculateTargetPriceTrade,
	convertToNumber,
	AMM_RESERVE_PRECISION,
	// Wallet,
	// calculateTradeSlippage,
	getLimitOrderParams,
	// getTriggerMarketOrderParams,
	findComputeUnitConsumption,
	QUOTE_PRECISION,
} from '../sdk/src';

import { Markets } from '../sdk/src/constants/markets';

import {
	createPriceFeed,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	getFeedData,
} from './testHelpers';

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

	const marketIndex = new BN(12); // for soft launch

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
			marketIndex,
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

		const targetPriceBack = new BN(
			initialSOLPrice * MARK_PRICE_PRECISION.toNumber()
		);

		// const [direction, tradeSize, _] = clearingHouse.calculateTargetPriceTrade(
		// 	marketIndex,
		// 	targetPriceUp
		// );
		await clearingHouse.moveAmmToPrice(marketIndex, targetPriceBack);
		await clearingHouse.updateFundingPaused(true);

		let count = 0;
		while (count <= 2) {
			await clearingHouse.openPosition(
				PositionDirection.LONG,
				new BN(100000).mul(QUOTE_PRECISION),
				marketIndex
			);
			await clearingHouse.closePosition(marketIndex);
			count += 1;
		}

		const markets = await clearingHouse.getMarketsAccount();

		const amm = markets.markets[marketIndex.toNumber()].amm;
		console.log(
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
	it('update funding/price (netRevenueSinceLastFunding)', async () => {
		await clearingHouse.updateFundingPaused(false);
		await new Promise((r) => setTimeout(r, 1000)); // wait 1 second

		const _tx = await clearingHouse.updateFundingRate(
			solUsdOracle,
			marketIndex
		);
		await new Promise((r) => setTimeout(r, 1000)); // wait 1 second
		await clearingHouse.updateFundingPaused(true);

		const markets = await clearingHouse.getMarketsAccount();
		const market = markets.markets[marketIndex.toNumber()];
		const amm = market.amm;

		await setFeedPrice(anchor.workspace.Pyth, 155, amm.oracle);

		const oraclePx = await getFeedData(anchor.workspace.Pyth, amm.oracle);

		console.log(
			'markPrice:',
			convertToNumber(calculateMarkPrice(market)),
			'oraclePrice:',
			oraclePx.price
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
	});

	it('cause repeg?', async () => {
		const markets = await clearingHouse.getMarketsAccount();
		const market = markets.markets[marketIndex.toNumber()];
		const amm = market.amm;
		const oraclePx = await getFeedData(anchor.workspace.Pyth, amm.oracle);

		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = MARK_PRICE_PRECISION.mul(new BN(oraclePx.price + 1));

		// const prePosition = userAccount.getUserPosition(marketIndex);
		// console.log(prePosition);
		// assert(prePosition == undefined); // no existing position

		// const fillerUserAccount0 = userAccount.getUserAccount();

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			false,
			false
		);
		const txSig = await clearingHouse.placeAndFillOrder(
			orderParams
			// discountTokenAccount.address
		);

		await clearingHouse.fetchAccounts();
		await userAccount.fetchAccounts();

		const postPosition = userAccount.getUserPosition(marketIndex);
		console.log(
			'User position: ',
			convertToNumber(new BN(0), AMM_RESERVE_PRECISION),
			'->',
			convertToNumber(postPosition.baseAssetAmount, AMM_RESERVE_PRECISION)
		);

		assert(postPosition.baseAssetAmount.abs().gt(new BN(0)));
		assert(postPosition.baseAssetAmount.eq(baseAssetAmount)); // 100% filled

		const marketsAfter = await clearingHouse.getMarketsAccount();
		const marketAfter = marketsAfter.markets[marketIndex.toNumber()];
		const ammAfter = marketAfter.amm;

		// const newPeg = calculateBudgetedPeg(marketAfter, new BN(15000000));
		console.log(
			'Expected Peg Change:',
			market.amm.pegMultiplier.toNumber(),
			'->',
			marketAfter.amm.pegMultiplier.toNumber()
			// ' vs ->',
			// newPeg.toNumber()
		);

		console.log(
			'Oracle:',
			oraclePx.price,
			'Mark:',
			convertToNumber(calculateMarkPrice(market)),
			'->',
			convertToNumber(calculateMarkPrice(marketAfter))
		);

		console.log(
			'Peg:',
			convertToNumber(amm.pegMultiplier, PEG_PRECISION),
			'->',
			convertToNumber(ammAfter.pegMultiplier, PEG_PRECISION),
			'(net rev=',
			convertToNumber(
				ammAfter.totalFeeMinusDistributions.sub(amm.totalFeeMinusDistributions),
				QUOTE_PRECISION
			),
			' | ',
			convertToNumber(amm.totalFeeMinusDistributions, QUOTE_PRECISION),
			'->',
			convertToNumber(ammAfter.totalFeeMinusDistributions, QUOTE_PRECISION),

			')'
		);

		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig
		);

		console.log('placeAndFill compute units', computeUnits[0]);
	});
	it('cause repeg? close', async () => {
		const markets = await clearingHouse.getMarketsAccount();
		const market = markets.markets[marketIndex.toNumber()];
		const amm = market.amm;
		const oraclePx = await getFeedData(anchor.workspace.Pyth, amm.oracle);

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = MARK_PRICE_PRECISION.mul(new BN(oraclePx.price - 10));

		const prePosition = userAccount.getUserPosition(marketIndex);
		// console.log(prePosition);
		// assert(prePosition == undefined); // no existing position

		// const fillerUserAccount0 = userAccount.getUserAccount();

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			false,
			false
		);
		const txSig = await clearingHouse.placeAndFillOrder(
			orderParams
			// discountTokenAccount.address
		);

		await clearingHouse.fetchAccounts();
		await userAccount.fetchAccounts();

		const postPosition = userAccount.getUserPosition(marketIndex);
		console.log(
			'User position: ',
			convertToNumber(prePosition.baseAssetAmount, AMM_RESERVE_PRECISION),
			'->',
			convertToNumber(postPosition.baseAssetAmount, AMM_RESERVE_PRECISION)
		);

		const marketsAfter = await clearingHouse.getMarketsAccount();
		const marketAfter = marketsAfter.markets[marketIndex.toNumber()];
		const ammAfter = marketAfter.amm;

		console.log(
			'Oracle:',
			oraclePx.price,
			'Mark:',
			convertToNumber(calculateMarkPrice(market)),
			'->',
			convertToNumber(calculateMarkPrice(marketAfter))
		);

		console.log(
			'Peg:',
			convertToNumber(amm.pegMultiplier, PEG_PRECISION),
			'->',
			convertToNumber(ammAfter.pegMultiplier, PEG_PRECISION),
			'(net rev=',
			convertToNumber(
				ammAfter.totalFeeMinusDistributions.sub(amm.totalFeeMinusDistributions),
				QUOTE_PRECISION
			),
			')'
		);
		try {
			const computeUnits = await findComputeUnitConsumption(
				clearingHouse.program.programId,
				connection,
				txSig
			);

			console.log('placeAndFill compute units', computeUnits[0]);
		} catch (e) {
			console.log('err calc in compute units');
		}
	});
});
