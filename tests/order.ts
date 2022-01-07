import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import BN from 'bn.js';

import { Program } from '@project-serum/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	Admin,
	MARK_PRICE_PRECISION,
	ClearingHouse,
	PositionDirection,
	OrderType,
	getUserOrdersAccountPublicKey,
	ClearingHouseUser,
	OrderStatus,
	OrderDiscountTier,
	OrderRecord,
	OrderAction,
	calculateTargetPriceTrade,
	convertToNumber,
	QUOTE_PRECISION,
	Wallet,
} from '../sdk/src';

import { calculateAmountToTradeForLimit } from '../sdk/src/orders';

import { mockOracle, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';
import {
	AMM_RESERVE_PRECISION,
	calculateMarkPrice,
	OrderTriggerCondition,
	ZERO,
} from '../sdk';
import { AccountInfo, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const enumsAreEqual = (
	actual: Record<string, unknown>,
	expected: Record<string, unknown>
): boolean => {
	return JSON.stringify(actual) === JSON.stringify(expected);
};

describe('orders', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	let clearingHouseUser: ClearingHouseUser;

	let userAccountPublicKey: PublicKey;
	let userOrdersAccountPublicKey: PublicKey;

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

	let discountMint: Token;
	let discountTokenAccount: AccountInfo;

	const fillerKeyPair = new Keypair();
	let fillerUSDCAccount: Keypair;
	let fillerClearingHouse: ClearingHouse;
	let fillerUser: ClearingHouseUser;

	const marketIndex = new BN(1);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId
		);
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribeToAll();

		const solUsd = await mockOracle(1);
		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			marketIndex,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		[, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		userOrdersAccountPublicKey = await getUserOrdersAccountPublicKey(
			clearingHouse.program.programId,
			provider.wallet.publicKey
		);

		clearingHouseUser = ClearingHouseUser.from(
			clearingHouse,
			provider.wallet.publicKey
		);
		await clearingHouseUser.subscribe();

		discountMint = await Token.createMint(
			connection,
			// @ts-ignore
			provider.wallet.payer,
			provider.wallet.publicKey,
			provider.wallet.publicKey,
			6,
			TOKEN_PROGRAM_ID
		);

		await clearingHouse.updateDiscountMint(discountMint.publicKey);

		discountTokenAccount = await discountMint.getOrCreateAssociatedAccountInfo(
			provider.wallet.publicKey
		);

		await discountMint.mintTo(
			discountTokenAccount.address,
			// @ts-ignore
			provider.wallet.payer,
			[],
			1000 * 10 ** 6
		);

		provider.connection.requestAirdrop(fillerKeyPair.publicKey, 10 ** 9);
		fillerUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			fillerKeyPair.publicKey
		);
		fillerClearingHouse = ClearingHouse.from(
			connection,
			new Wallet(fillerKeyPair),
			chProgram.programId
		);
		await fillerClearingHouse.subscribe();

		await fillerClearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			fillerUSDCAccount.publicKey
		);

		fillerUser = ClearingHouseUser.from(
			fillerClearingHouse,
			fillerKeyPair.publicKey
		);
		await fillerUser.subscribe();
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
		await fillerUser.unsubscribe();
	});

	it('Open long limit order', async () => {
		// user has $10, no open positions, trading in market of $1 mark price coin
		const orderType = OrderType.LIMIT;
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = MARK_PRICE_PRECISION.mul(new BN(2));
		const reduceOnly = true;
		const triggerPrice = new BN(0);

		// user sets reduce-only taker limit buy @ $2
		await clearingHouse.placeOrder(
			orderType,
			direction,
			baseAssetAmount,
			price,
			marketIndex,
			reduceOnly,
			undefined,
			undefined,
			discountTokenAccount.address
		);

		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[0];
		const expectedOrderId = new BN(1);

		assert(order.baseAssetAmount.eq(baseAssetAmount));
		assert(order.price.eq(price));
		assert(order.triggerPrice.eq(triggerPrice));
		assert(order.marketIndex.eq(marketIndex));
		assert(order.reduceOnly === reduceOnly);
		assert(enumsAreEqual(order.direction, direction));
		assert(enumsAreEqual(order.status, OrderStatus.OPEN));
		assert(enumsAreEqual(order.discountTier, OrderDiscountTier.FOURTH));
		assert(order.orderId.eq(expectedOrderId));
		assert(order.ts.gt(ZERO));

		const userPositionsAccount = clearingHouseUser.getUserPositionsAccount();
		const position = userPositionsAccount.positions[0];
		const expectedOpenOrders = new BN(1);
		assert(position.openOrders.eq(expectedOpenOrders));

		const orderHistoryAccount = clearingHouse.getOrderHistoryAccount();
		const orderRecord: OrderRecord = orderHistoryAccount.orderRecords[0];
		const expectedRecordId = new BN(1);
		assert(orderRecord.recordId.eq(expectedRecordId));
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.order.orderId.eq(expectedOrderId));
		assert(enumsAreEqual(orderRecord.action, OrderAction.PLACE));
		assert(
			orderRecord.user.equals(await clearingHouseUser.getUserAccountPublicKey())
		);
		assert(orderRecord.authority.equals(clearingHouseUser.authority));
	});

	it('Fail to fill reduce only order', async () => {
		const orderIndex = new BN(0);

		try {
			await fillerClearingHouse.fillOrder(
				userAccountPublicKey,
				userOrdersAccountPublicKey,
				orderIndex
			);
		} catch (e) {
			return;
		}

		assert(false);
	});

	it('Cancel order', async () => {
		const orderIndex = new BN(0);
		await clearingHouse.cancelOrder(orderIndex);

		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[orderIndex.toString()];

		assert(order.baseAssetAmount.eq(new BN(0)));
		assert(order.price.eq(new BN(0)));
		assert(order.marketIndex.eq(new BN(0)));
		assert(enumsAreEqual(order.direction, PositionDirection.LONG));
		assert(enumsAreEqual(order.status, OrderStatus.INIT));

		const userPositionsAccount = clearingHouseUser.getUserPositionsAccount();
		const position = userPositionsAccount.positions[0];
		const expectedOpenOrders = new BN(0);
		assert(position.openOrders.eq(expectedOpenOrders));

		const orderHistoryAccount = clearingHouse.getOrderHistoryAccount();
		const orderRecord: OrderRecord = orderHistoryAccount.orderRecords[1];
		const expectedRecordId = new BN(2);
		const expectedOrderId = new BN(1);
		assert(orderRecord.recordId.eq(expectedRecordId));
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.order.orderId.eq(expectedOrderId));
		assert(enumsAreEqual(orderRecord.action, OrderAction.CANCEL));
		assert(
			orderRecord.user.equals(await clearingHouseUser.getUserAccountPublicKey())
		);
		assert(orderRecord.authority.equals(clearingHouseUser.authority));
	});

	it('Fill limit long order', async () => {
		const orderType = OrderType.LIMIT;
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = MARK_PRICE_PRECISION.mul(new BN(2));
		await clearingHouse.placeOrder(
			orderType,
			direction,
			baseAssetAmount,
			price,
			marketIndex,
			false,
			undefined,
			undefined,
			discountTokenAccount.address
		);
		const orderIndex = new BN(0);
		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			userOrdersAccountPublicKey,
			orderIndex
		);

		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[orderIndex.toString()];

		const fillerUserAccount = fillerUser.getUserAccount();
		const expectedFillerReward = new BN(95);
		assert(
			fillerUserAccount.collateral.sub(usdcAmount).eq(expectedFillerReward)
		);

		const market = clearingHouse.getMarket(marketIndex);
		const expectedFeeToMarket = new BN(855);
		assert(market.amm.totalFee.eq(expectedFeeToMarket));

		const userAccount = clearingHouseUser.getUserAccount();
		const expectedTokenDiscount = new BN(50);
		assert(userAccount.totalTokenDiscount.eq(expectedTokenDiscount));

		assert(order.baseAssetAmount.eq(new BN(0)));
		assert(order.price.eq(new BN(0)));
		assert(order.marketIndex.eq(new BN(0)));
		assert(enumsAreEqual(order.direction, PositionDirection.LONG));
		assert(enumsAreEqual(order.status, OrderStatus.INIT));

		const userPositionsAccount = clearingHouseUser.getUserPositionsAccount();
		const firstPosition = userPositionsAccount.positions[0];
		assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));

		const expectedQuoteAssetAmount = new BN(1000003);
		assert(firstPosition.quoteAssetAmount.eq(expectedQuoteAssetAmount));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();
		const tradeHistoryRecord = tradeHistoryAccount.tradeRecords[0];

		assert.ok(tradeHistoryAccount.head.toNumber() === 1);
		assert.ok(tradeHistoryRecord.baseAssetAmount.eq(baseAssetAmount));
		assert.ok(tradeHistoryRecord.quoteAssetAmount.eq(expectedQuoteAssetAmount));

		const orderHistoryAccount = clearingHouse.getOrderHistoryAccount();
		const orderRecord: OrderRecord = orderHistoryAccount.orderRecords[3];
		const expectedRecordId = new BN(4);
		const expectedOrderId = new BN(2);
		const expectedTradeRecordId = new BN(1);
		assert(orderRecord.recordId.eq(expectedRecordId));
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.order.orderId.eq(expectedOrderId));
		assert(enumsAreEqual(orderRecord.action, OrderAction.FILL));
		assert(
			orderRecord.user.equals(await clearingHouseUser.getUserAccountPublicKey())
		);
		assert(orderRecord.authority.equals(clearingHouseUser.authority));
		assert(
			orderRecord.filler.equals(await fillerUser.getUserAccountPublicKey())
		);
		assert(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert(orderRecord.quoteAssetAmount.eq(expectedQuoteAssetAmount));
		assert(orderRecord.fillerReward.eq(expectedFillerReward));
		assert(orderRecord.tradeRecordId.eq(expectedTradeRecordId));
	});

	it('Fill stop short order', async () => {
		const orderType = OrderType.STOP;
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = new BN(0);
		const triggerPrice = MARK_PRICE_PRECISION;
		const triggerCondition = OrderTriggerCondition.ABOVE;
		await clearingHouse.placeOrder(
			orderType,
			direction,
			baseAssetAmount,
			price,
			marketIndex,
			false,
			triggerPrice,
			triggerCondition,
			discountTokenAccount.address
		);
		const orderIndex = new BN(0);
		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			userOrdersAccountPublicKey,
			orderIndex
		);

		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[orderIndex.toString()];

		const fillerUserAccount = fillerUser.getUserAccount();
		const expectedFillerReward = new BN(190);
		assert(
			fillerUserAccount.collateral.sub(usdcAmount).eq(expectedFillerReward)
		);

		const market = clearingHouse.getMarket(marketIndex);
		const expectedFeeToMarket = new BN(1710);
		assert(market.amm.totalFee.eq(expectedFeeToMarket));

		const userAccount = clearingHouseUser.getUserAccount();
		const expectedTokenDiscount = new BN(100);
		assert(userAccount.totalTokenDiscount.eq(expectedTokenDiscount));

		assert(order.baseAssetAmount.eq(new BN(0)));
		assert(order.price.eq(new BN(0)));
		assert(order.marketIndex.eq(new BN(0)));
		assert(enumsAreEqual(order.direction, PositionDirection.LONG));
		assert(enumsAreEqual(order.status, OrderStatus.INIT));

		const userPositionsAccount = clearingHouseUser.getUserPositionsAccount();
		const firstPosition = userPositionsAccount.positions[0];
		const expectedBaseAssetAmount = new BN(0);
		assert(firstPosition.baseAssetAmount.eq(expectedBaseAssetAmount));

		const expectedQuoteAssetAmount = new BN(0);
		assert(firstPosition.quoteAssetAmount.eq(expectedQuoteAssetAmount));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();
		const tradeHistoryRecord = tradeHistoryAccount.tradeRecords[1];

		assert.ok(tradeHistoryAccount.head.toNumber() === 2);
		assert.ok(tradeHistoryRecord.baseAssetAmount.eq(baseAssetAmount));
		const expectedTradeQuoteAssetAmount = new BN(1000002);
		assert.ok(
			tradeHistoryRecord.quoteAssetAmount.eq(expectedTradeQuoteAssetAmount)
		);
		assert.ok(tradeHistoryRecord.markPriceBefore.gt(triggerPrice));

		const orderHistoryAccount = clearingHouse.getOrderHistoryAccount();
		const orderRecord: OrderRecord = orderHistoryAccount.orderRecords[5];
		const expectedRecordId = new BN(6);
		const expectedOrderId = new BN(3);
		const expectedTradeRecordId = new BN(2);
		assert(orderRecord.recordId.eq(expectedRecordId));
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.order.orderId.eq(expectedOrderId));
		assert(enumsAreEqual(orderRecord.action, OrderAction.FILL));
		assert(
			orderRecord.user.equals(await clearingHouseUser.getUserAccountPublicKey())
		);
		assert(orderRecord.authority.equals(clearingHouseUser.authority));
		assert(
			orderRecord.filler.equals(await fillerUser.getUserAccountPublicKey())
		);
		assert(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert(orderRecord.quoteAssetAmount.eq(expectedTradeQuoteAssetAmount));
		assert(orderRecord.tradeRecordId.eq(expectedTradeRecordId));
	});

	it('Fail to fill limit short order', async () => {
		const orderType = OrderType.LIMIT;
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const market = clearingHouse.getMarket(marketIndex);
		const limitPrice = calculateMarkPrice(market); // 0 liquidity at current mark price
		await clearingHouse.placeOrder(
			orderType,
			direction,
			baseAssetAmount,
			limitPrice,
			marketIndex,
			false,
			undefined,
			undefined,
			discountTokenAccount.address
		);

		const orderIndex = new BN(0);

		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[0];
		const amountToFill = calculateAmountToTradeForLimit(market, order);

		assert(amountToFill.eq(ZERO));

		console.log(amountToFill);

		try {
			await fillerClearingHouse.fillOrder(
				userAccountPublicKey,
				userOrdersAccountPublicKey,
				orderIndex
			);
			await clearingHouse.cancelOrder(orderIndex);
		} catch (e) {
			await clearingHouse.cancelOrder(orderIndex);
			return;
		}

		assert(false);
	});

	it('Partial fill limit short order', async () => {
		const orderType = OrderType.LIMIT;
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const market = clearingHouse.getMarket(marketIndex);
		const limitPrice = calculateMarkPrice(market).sub(new BN(10000)); // 0 liquidity at current mark price
		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');
		assert(!amountToPrice.eq(ZERO));
		assert(newDirection == direction);

		console.log(
			convertToNumber(calculateMarkPrice(market)),
			'then short @',
			convertToNumber(limitPrice),
			newDirection,
			convertToNumber(newMarkPrice),
			'available liquidity',
			convertToNumber(amountToPrice, AMM_RESERVE_PRECISION)
		);

		assert(baseAssetAmount.gt(amountToPrice)); // assert its a partial fill of liquidity

		// const triggerPrice = new BN(0);
		// const triggerCondition = OrderTriggerCondition.BELOW;
		await clearingHouse.placeOrder(
			orderType,
			direction,
			baseAssetAmount,
			limitPrice,
			marketIndex,
			false,
			undefined,
			undefined,
			discountTokenAccount.address
		);

		const orderIndex = new BN(0);

		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[0];
		const amountToFill = calculateAmountToTradeForLimit(market, order);

		console.log(amountToFill);

		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			userOrdersAccountPublicKey,
			orderIndex
		);

		const market2 = clearingHouse.getMarket(marketIndex);
		const userOrdersAccount2 = clearingHouseUser.getUserOrdersAccount();
		const order2 = userOrdersAccount2.orders[0];
		console.log(
			'order filled: ',
			convertToNumber(order.baseAssetAmount),
			'->',
			convertToNumber(order2.baseAssetAmount)
		);
		console.log(order2);
		const userPositionsAccount = clearingHouseUser.getUserPositionsAccount();
		const position = userPositionsAccount.positions[0];
		console.log(
			'curPosition',
			convertToNumber(position.baseAssetAmount, AMM_RESERVE_PRECISION)
		);

		assert(order.baseAssetAmountFilled.eq(ZERO));
		assert(order.baseAssetAmount.eq(order2.baseAssetAmount));
		assert(order2.baseAssetAmountFilled.gt(ZERO));
		assert(
			order2.baseAssetAmount
				.sub(order2.baseAssetAmountFilled)
				.add(position.baseAssetAmount.abs())
				.eq(order.baseAssetAmount)
		);

		const amountToFill2 = calculateAmountToTradeForLimit(market2, order2);
		assert(amountToFill2.eq(ZERO));

		const userAccount = clearingHouseUser.getUserAccount();
		const userNetGain = clearingHouseUser
			.getTotalCollateral()
			.add(userAccount.totalFeePaid)
			.sub(userAccount.cumulativeDeposits);

		assert(userNetGain.lte(ZERO)); // ensure no funny business
		console.log(
			'user net gain:',
			convertToNumber(userNetGain, QUOTE_PRECISION)
		);

		await clearingHouse.cancelOrder(orderIndex);
	});

	it('todo: Max leverage fill limit short order', async () => {
		//todo, partial fill wont work on order too large

		const orderType = OrderType.LIMIT;
		const direction = PositionDirection.SHORT;

		const market = clearingHouse.getMarket(marketIndex);
		const limitPrice = calculateMarkPrice(market); // 0 liquidity at current mark price
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION.mul(new BN(40)));
		//long 50 base amount at $1 with ~$10 collateral (max leverage = 5x)

		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');
		assert(amountToPrice.eq(ZERO)); // no liquidity now

		console.log(
			convertToNumber(calculateMarkPrice(market)),
			'then short @',
			convertToNumber(limitPrice),
			newDirection,
			convertToNumber(newMarkPrice),
			'available liquidity',
			convertToNumber(amountToPrice, AMM_RESERVE_PRECISION)
		);

		assert(baseAssetAmount.gt(amountToPrice)); // assert its a partial fill of liquidity

		// const triggerPrice = new BN(0);
		// const triggerCondition = OrderTriggerCondition.BELOW;
		await clearingHouse.placeOrder(
			orderType,
			direction,
			baseAssetAmount,
			limitPrice,
			marketIndex,
			false,
			undefined,
			undefined,
			discountTokenAccount.address
		);

		const orderIndex = new BN(0);

		// move price to make liquidity for order @ $1.05 (5%)
		await clearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(1.05 * MARK_PRICE_PRECISION.toNumber())
		);

		const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
		const order = userOrdersAccount.orders[0];
		const amountToFill = calculateAmountToTradeForLimit(market, order);

		console.log(amountToFill);

		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			userOrdersAccountPublicKey,
			orderIndex
		);

		const userAccount = clearingHouseUser.getUserAccount();
		const userNetGain = clearingHouseUser
			.getTotalCollateral()
			.add(userAccount.totalFeePaid)
			.sub(userAccount.cumulativeDeposits);

		assert(userNetGain.lte(ZERO)); // ensure no funny business
		console.log(
			'user net gain:',
			convertToNumber(userNetGain, QUOTE_PRECISION)
		);

		// await clearingHouse.cancelOrder(orderIndex);
	});
});
