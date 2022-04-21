import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN, calculateBudgetedK } from '../sdk';

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
	calculateAdjustKCost,
	findComputeUnitConsumption,
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

describe('formulaic curve (k)', () => {
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
			chProgram.programId,
			{
				commitment: 'confirmed',
				preflightCommitment: 'confirmed',
			}
		);
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribeToAll();

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

		await clearingHouse.updateFormulaicUpdateIntensity(
			Markets[0].marketIndex,
			100
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

		console.log(
			'oldSqrtK',
			convertToNumber(ammOld.sqrtK),
			'oldKPrice:',
			convertToNumber(oldKPrice)
		);

		console.log(
			'newSqrtK',
			convertToNumber(amm.sqrtK),
			'newKPrice:',
			convertToNumber(newKPrice)
		);

		assert(ammOld.sqrtK.eq(amm.sqrtK));
		assert(newKPrice.sub(oldKPrice).abs().lt(marginOfError));
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
	it('update funding (no k change)', async () => {
		const marketIndex = Markets[0].marketIndex;
		const marketsOld = await clearingHouse.getMarketsAccount();
		const marketOld = marketsOld.markets[0];
		const ammOld = marketOld.amm;

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

		console.log(
			'oldSqrtK',
			convertToNumber(ammOld.sqrtK),
			'newSqrtK',
			convertToNumber(amm.sqrtK)
		);

		// await setFeedPrice(program, newPrice, priceFeedAddress);
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

		assert(amm.netRevenueSinceLastFunding.eq(ZERO));
		assert(amm.sqrtK);
	});

	it('update funding (k increase by max .01%)', async () => {
		const marketIndex = Markets[0].marketIndex;
		const marketsOld = await clearingHouse.getMarketsAccount();
		const marketOld = marketsOld.markets[0];
		const ammOld = marketsOld.markets[0].amm;
		assert(marketOld.baseAssetAmount.eq(ZERO));

		console.log('taking position');
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			new BN(10000).mul(QUOTE_PRECISION),
			marketIndex
		);
		console.log('$10000 position taken');
		const marketsAfterPos = await clearingHouse.getMarketsAccount();
		const marketAfterPos = marketsAfterPos.markets[0];
		// const ammAfterPos = marketAfterPos.amm;
		const maxAdjCost = calculateAdjustKCost(
			marketAfterPos,
			marketIndex,
			new BN(10010),
			new BN(10000)
		);
		const [pNumer, pDenom] = calculateBudgetedK(marketAfterPos, maxAdjCost);

		console.log(
			'max increase k cost:',
			convertToNumber(maxAdjCost, QUOTE_PRECISION),
			'budget k back out scale: multiply by',
			convertToNumber(pNumer) / convertToNumber(pDenom)
		);

		await clearingHouse.updateFundingPaused(false);
		await new Promise((r) => setTimeout(r, 1000)); // wait 1 second

		const txSig = await clearingHouse.updateFundingRate(
			solUsdOracle,
			marketIndex
		);
		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig,
			'confirmed'
		);
		console.log('compute units', computeUnits);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		await new Promise((r) => setTimeout(r, 1000)); // wait 1 second
		await clearingHouse.updateFundingPaused(true);

		const markets = await clearingHouse.getMarketsAccount();
		const market = markets.markets[0];
		const amm = market.amm;

		// await setFeedPrice(program, newPrice, priceFeedAddress);
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

		console.log(
			'oldSqrtK',
			convertToNumber(ammOld.sqrtK),
			'newSqrtK',
			convertToNumber(amm.sqrtK)
		);

		// traders over traded => increase of k
		assert(amm.sqrtK.gt(ammOld.sqrtK));

		const curveHistoryAccount = clearingHouse.getCurveHistoryAccount();
		const curveHistoryHead = curveHistoryAccount.head.toNumber();
		assert.ok(curveHistoryHead === 1);
		const cRecord = curveHistoryAccount.curveRecords[curveHistoryHead - 1];

		console.log(
			'curve cost:',
			convertToNumber(cRecord.adjustmentCost, QUOTE_PRECISION)
		);

		assert(amm.netRevenueSinceLastFunding.eq(ZERO));
	});
	it('update funding (k decrease by max .009%)', async () => {
		const marketIndex = Markets[0].marketIndex;
		const marketsOld = await clearingHouse.getMarketsAccount();
		const marketOld = marketsOld.markets[marketIndex.toNumber()];
		const ammOld = marketOld.amm;
		await setFeedPrice(
			anchor.workspace.Pyth,
			initialSOLPrice * 1.05,
			solUsdOracle
		);

		// await setFeedPrice(program, newPrice, priceFeedAddress);
		const oraclePxOld = await getFeedData(anchor.workspace.Pyth, ammOld.oracle);

		console.log(
			'markPrice:',
			convertToNumber(calculateMarkPrice(marketOld)),
			'oraclePrice:',
			oraclePxOld.price
		);

		const maxAdjCost = calculateAdjustKCost(
			marketsOld.markets[marketIndex.toNumber()],
			marketIndex,
			new BN(9991),
			new BN(10000)
		);

		const maxAdjCostShrink100x = calculateAdjustKCost(
			marketsOld.markets[marketIndex.toNumber()],
			marketIndex,
			new BN(1),
			new BN(100)
		);

		const [pNumer, pDenom] = calculateBudgetedK(marketOld, maxAdjCost);

		const [pNumer2, pDenom2] = calculateBudgetedK(marketOld, new BN(-112934)); // ~$.11

		console.log(
			'max decrease k cost:',
			convertToNumber(maxAdjCost, QUOTE_PRECISION),
			'budget k back out scale: multiply by',
			convertToNumber(pNumer) / convertToNumber(pDenom),
			'\n',
			'1/100th k cost:',
			convertToNumber(maxAdjCostShrink100x, QUOTE_PRECISION),
			'budget k $-13:',
			convertToNumber(pNumer2) / convertToNumber(pDenom2)
		);

		// console.log('taking position');
		// await clearingHouse.openPosition(
		// 	PositionDirection.LONG,
		// 	new BN(10000).mul(QUOTE_PRECISION),
		// 	marketIndex
		// );
		// console.log('$10000 position taken');

		await clearingHouse.updateFundingPaused(false);
		await new Promise((r) => setTimeout(r, 1000)); // wait 1 secon

		const _tx = await clearingHouse.updateFundingRate(
			solUsdOracle,
			marketIndex
		);
		await new Promise((r) => setTimeout(r, 1000)); // wait 1 second
		await clearingHouse.updateFundingPaused(true);

		const markets = await clearingHouse.getMarketsAccount();
		const market = markets.markets[0];
		const amm = market.amm;

		// await setFeedPrice(program, newPrice, priceFeedAddress);
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

		console.log(
			'oldSqrtK',
			convertToNumber(ammOld.sqrtK),
			'newSqrtK',
			convertToNumber(amm.sqrtK)
		);

		// traders over traded => increase of k
		assert(amm.sqrtK.lt(ammOld.sqrtK));

		const curveHistoryAccount = clearingHouse.getCurveHistoryAccount();
		const curveHistoryHead = curveHistoryAccount.head.toNumber();
		assert.ok(curveHistoryHead === 2);
		const cRecord = curveHistoryAccount.curveRecords[curveHistoryHead - 1];

		console.log(
			'curve cost:',
			convertToNumber(cRecord.adjustmentCost, QUOTE_PRECISION)
		);

		assert(amm.netRevenueSinceLastFunding.eq(ZERO));
	});
});
