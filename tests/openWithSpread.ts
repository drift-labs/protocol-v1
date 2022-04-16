import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import {
	Admin,
	BN,
	MARK_PRICE_PRECISION,
	PositionDirection,
	ClearingHouseUser,
	OrderRecord,
	OrderAction,
	getMarketOrderParams,
	findComputeUnitConsumption,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
} from './testHelpers';
import {
	AMM_RESERVE_PRECISION,
	calculateTradeAcquiredAmounts,
	FeeStructure,
	QUOTE_PRECISION,
	ZERO,
} from '../sdk';

const enumsAreEqual = (
	actual: Record<string, unknown>,
	expected: Record<string, unknown>
): boolean => {
	return JSON.stringify(actual) === JSON.stringify(expected);
};

describe('market order', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	let clearingHouseUser: ClearingHouseUser;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	const marketIndex = new BN(0);
	let solUsd;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			}
		);
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribeToAll();
		solUsd = await mockOracle(1);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			marketIndex,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await clearingHouse.updateMarketBaseSpread(marketIndex, 500);
		const feeStructure: FeeStructure = {
			feeNumerator: new BN(5), // 5bps
			feeDenominator: new BN(10000),
			discountTokenTiers: {
				firstTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
				secondTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
				thirdTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
				fourthTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
			},
			referralDiscount: {
				referrerRewardNumerator: new BN(1),
				referrerRewardDenominator: new BN(1),
				refereeDiscountNumerator: new BN(1),
				refereeDiscountDenominator: new BN(1),
			},
		};
		await clearingHouse.updateFee(feeStructure);

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		clearingHouseUser = ClearingHouseUser.from(
			clearingHouse,
			provider.wallet.publicKey
		);
		await clearingHouseUser.subscribe();
	});

	beforeEach(async () => {
		await clearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			ZERO
		);
		await setFeedPrice(anchor.workspace.Pyth, 1, solUsd);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('Long market order base', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);

		const tradeAcquiredAmountsNoSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			clearingHouse.getMarket(0),
			'base',
			false
		);
		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			clearingHouse.getMarket(0),
			'base',
			true
		);
		console.log(tradeAcquiredAmountsNoSpread[1].toString());
		console.log(tradeAcquiredAmountsWithSpread[1].toString());

		const orderParams = getMarketOrderParams(
			marketIndex,
			direction,
			ZERO,
			baseAssetAmount,
			false
		);
		const txSig = await clearingHouse.placeAndFillOrder(orderParams);
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

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const market = clearingHouse.getMarket(marketIndex);
		const expectedFeeToMarket = new BN(1000);
		assert(market.amm.totalFee.eq(expectedFeeToMarket));

		const userPositionsAccount = clearingHouseUser.getUserPositionsAccount();
		const firstPosition = userPositionsAccount.positions[0];
		assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));

		const expectedQuoteAssetAmount = new BN(1000503);
		assert(firstPosition.quoteAssetAmount.eq(expectedQuoteAssetAmount));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();
		const tradeHistoryRecord = tradeHistoryAccount.tradeRecords[0];

		assert.ok(tradeHistoryAccount.head.toNumber() === 1);
		assert.ok(tradeHistoryRecord.baseAssetAmount.eq(baseAssetAmount));
		assert.ok(tradeHistoryRecord.quoteAssetAmount.eq(expectedQuoteAssetAmount));

		const orderHistoryAccount = clearingHouse.getOrderHistoryAccount();
		const orderRecord: OrderRecord = orderHistoryAccount.orderRecords[1];
		const expectedRecordId = new BN(2);
		const expectedOrderId = new BN(1);
		const expectedTradeRecordId = new BN(1);
		const expectedFee = new BN(500);
		assert(orderRecord.recordId.eq(expectedRecordId));
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.order.orderId.eq(expectedOrderId));
		assert(orderRecord.fee.eq(expectedFee));
		assert(orderRecord.order.fee.eq(expectedFee));
		assert(enumsAreEqual(orderRecord.action, OrderAction.FILL));
		assert(
			orderRecord.user.equals(await clearingHouseUser.getUserAccountPublicKey())
		);
		assert(orderRecord.authority.equals(clearingHouseUser.authority));
		assert(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert(orderRecord.quoteAssetAmountFilled.eq(expectedQuoteAssetAmount));
		assert(orderRecord.fillerReward.eq(ZERO));
		assert(orderRecord.tradeRecordId.eq(expectedTradeRecordId));
	});

	it('Long market order quote', async () => {
		const direction = PositionDirection.LONG;
		const quoteAssetAmount = new BN(QUOTE_PRECISION);

		const orderParams = getMarketOrderParams(
			marketIndex,
			direction,
			quoteAssetAmount,
			ZERO,
			false
		);
		const txSig = await clearingHouse.placeAndFillOrder(orderParams);
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

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		const market = clearingHouse.getMarket(marketIndex);
		const expectedTotalFee = new BN(2000);
		assert(market.amm.totalFee.eq(expectedTotalFee));
		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();
		const tradeHistoryRecord = tradeHistoryAccount.tradeRecords[1];

		const expectedBaseAssetAmount = new BN(9994981889408);
		assert.ok(tradeHistoryRecord.baseAssetAmount.eq(expectedBaseAssetAmount));
		assert.ok(tradeHistoryRecord.quoteAssetAmount.eq(quoteAssetAmount));

		const orderHistoryAccount = clearingHouse.getOrderHistoryAccount();
		const orderRecord: OrderRecord = orderHistoryAccount.orderRecords[3];
		const expectedFee = new BN(500);
		assert(orderRecord.fee.eq(expectedFee));
		assert(orderRecord.order.fee.eq(expectedFee));
	});
});
