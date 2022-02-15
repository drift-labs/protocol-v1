import { PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import { ClearingHouse } from './clearingHouse';
import {
	Order,
	UserAccount,
	UserOrdersAccount,
	UserPosition,
	UserPositionsAccount,
} from './types';
import { calculateEntryPrice, isEmptyPosition } from './math/position';
import {
	MARK_PRICE_PRECISION,
	AMM_TO_QUOTE_PRECISION_RATIO,
	ZERO,
	TEN_THOUSAND,
	BN_MAX,
	PARTIAL_LIQUIDATION_RATIO,
	FULL_LIQUIDATION_RATIO,
	QUOTE_PRECISION,
	AMM_RESERVE_PRECISION,
	PRICE_TO_QUOTE_PRECISION,
} from './constants/numericConstants';
import { UserAccountSubscriber, UserAccountEvents } from './accounts/types';
import {
	calculateMarkPrice,
	calculateBaseAssetValue,
	calculatePositionFundingPNL,
	calculatePositionPNL,
	PositionDirection,
	getUserOrdersAccountPublicKey,
	calculateNewStateAfterOrder,
	calculateTradeSlippage,
	BN,
} from '.';
import { getUserAccountPublicKey } from './addresses';
import {
	getClearingHouseUser,
	getWebSocketClearingHouseUserConfig,
} from './factory/clearingHouseUser';

export class ClearingHouseUser {
	clearingHouse: ClearingHouse;
	authority: PublicKey;
	accountSubscriber: UserAccountSubscriber;
	userAccountPublicKey?: PublicKey;
	userOrdersAccountPublicKey?: PublicKey;
	_isSubscribed = false;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;

	public get isSubscribed() {
		return this._isSubscribed && this.accountSubscriber.isSubscribed;
	}

	public set isSubscribed(val: boolean) {
		this._isSubscribed = val;
	}

	/**
	 * @deprecated You should use getClearingHouseUser factory method instead
	 * @param clearingHouse
	 * @param authority
	 * @returns
	 */
	public static from(
		clearingHouse: ClearingHouse,
		authority: PublicKey
	): ClearingHouseUser {
		if (clearingHouse.accountSubscriber.type !== 'websocket')
			throw 'This method only works for clearing houses with a websocket account listener. Try using the getClearingHouseUser factory method to initialize a ClearingHouseUser instead';

		const config = getWebSocketClearingHouseUserConfig(
			clearingHouse,
			authority
		);
		return getClearingHouseUser(config);
	}

	public constructor(
		clearingHouse: ClearingHouse,
		authority: PublicKey,
		accountSubscriber: UserAccountSubscriber
	) {
		this.clearingHouse = clearingHouse;
		this.authority = authority;
		this.accountSubscriber = accountSubscriber;
		this.eventEmitter = this.accountSubscriber.eventEmitter;
	}

	/**
	 * Subscribe to ClearingHouseUser state accounts
	 * @returns SusbcriptionSuccess result
	 */
	public async subscribe(): Promise<boolean> {
		// Clearing house should already be subscribed, but await for the subscription just incase to avoid race condition
		await this.clearingHouse.subscribe();

		this.isSubscribed = await this.accountSubscriber.subscribe();
		return this.isSubscribed;
	}

	/**
	 *	Forces the accountSubscriber to fetch account updates from rpc
	 */
	public async fetchAccounts(): Promise<void> {
		await this.accountSubscriber.fetch();
	}

	public async unsubscribe(): Promise<void> {
		await this.accountSubscriber.unsubscribe();
		this.isSubscribed = false;
	}

	public getUserAccount(): UserAccount {
		return this.accountSubscriber.getUserAccount();
	}

	public getUserPositionsAccount(): UserPositionsAccount {
		return this.accountSubscriber.getUserPositionsAccount();
	}

	public getUserOrdersAccount(): UserOrdersAccount | undefined {
		return this.accountSubscriber.getUserOrdersAccount();
	}

	/**
	 * Gets the user's current position for a given market. If the user has no position returns undefined
	 * @param marketIndex
	 * @returns userPosition
	 */
	public getUserPosition(marketIndex: BN): UserPosition | undefined {
		return this.getUserPositionsAccount().positions.find((position) =>
			position.marketIndex.eq(marketIndex)
		);
	}

	public getEmptyPosition(marketIndex: BN): UserPosition {
		return {
			baseAssetAmount: ZERO,
			lastCumulativeFundingRate: ZERO,
			marketIndex,
			quoteAssetAmount: ZERO,
			openOrders: ZERO,
		};
	}

	/**
	 * @param orderId
	 * @returns Order
	 */
	public getOrder(orderId: BN): Order | undefined {
		return this.getUserOrdersAccount().orders.find((order) =>
			order.orderId.eq(orderId)
		);
	}

	/**
	 * @param userOrderId
	 * @returns Order
	 */
	public getOrderByUserOrderId(userOrderId: number): Order | undefined {
		return this.getUserOrdersAccount().orders.find(
			(order) => order.userOrderId === userOrderId
		);
	}

	public async getUserAccountPublicKey(): Promise<PublicKey> {
		if (this.userAccountPublicKey) {
			return this.userAccountPublicKey;
		}

		this.userAccountPublicKey = await getUserAccountPublicKey(
			this.clearingHouse.program.programId,
			this.authority
		);
		return this.userAccountPublicKey;
	}

	public async getUserOrdersAccountPublicKey(): Promise<PublicKey> {
		if (this.userOrdersAccountPublicKey) {
			return this.userOrdersAccountPublicKey;
		}

		this.userOrdersAccountPublicKey = await getUserOrdersAccountPublicKey(
			this.clearingHouse.program.programId,
			await this.getUserAccountPublicKey()
		);
		return this.userOrdersAccountPublicKey;
	}

	public async exists(): Promise<boolean> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const userAccountRPCResponse =
			await this.clearingHouse.connection.getParsedAccountInfo(
				userAccountPublicKey
			);
		return userAccountRPCResponse.value !== null;
	}

	/**
	 * calculates Buying Power = FC * MAX_LEVERAGE
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getBuyingPower(): BN {
		return this.getFreeCollateral()
			.mul(this.getMaxLeverage('Initial'))
			.div(TEN_THOUSAND);
	}

	/**
	 * calculates Free Collateral = (TC - TPV) * MAX_LEVERAGE
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getFreeCollateral(): BN {
		return this.getTotalCollateral().sub(
			this.getTotalPositionValue()
				.mul(TEN_THOUSAND)
				.div(this.getMaxLeverage('Initial'))
		);
	}

	/**
	 * calculates unrealized position price pnl
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getUnrealizedPNL(withFunding?: boolean, marketIndex?: BN): BN {
		return this.getUserPositionsAccount()
			.positions.filter((pos) =>
				marketIndex ? pos.marketIndex === marketIndex : true
			)
			.reduce((pnl, marketPosition) => {
				const market = this.clearingHouse.getMarket(marketPosition.marketIndex);
				return pnl.add(
					calculatePositionPNL(market, marketPosition, withFunding)
				);
			}, ZERO);
	}

	/**
	 * calculates unrealized funding payment pnl
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getUnrealizedFundingPNL(marketIndex?: BN): BN {
		return this.getUserPositionsAccount()
			.positions.filter((pos) =>
				marketIndex ? pos.marketIndex === marketIndex : true
			)
			.reduce((pnl, marketPosition) => {
				const market = this.clearingHouse.getMarket(marketPosition.marketIndex);
				return pnl.add(calculatePositionFundingPNL(market, marketPosition));
			}, ZERO);
	}

	/**
	 * calculates TotalCollateral: collateral + unrealized pnl
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getTotalCollateral(): BN {
		return (
			this.getUserAccount().collateral.add(this.getUnrealizedPNL(true)) ??
			new BN(0)
		);
	}

	/**
	 * calculates sum of position value across all positions
	 * @returns : Precision QUOTE_PRECISION
	 */
	getTotalPositionValue(): BN {
		return this.getUserPositionsAccount().positions.reduce(
			(positionValue, marketPosition) => {
				const market = this.clearingHouse.getMarket(marketPosition.marketIndex);
				return positionValue.add(
					calculateBaseAssetValue(market, marketPosition)
				);
			},
			ZERO
		);
	}

	/**
	 * calculates position value from closing 100%
	 * @returns : Precision QUOTE_PRECISION
	 */
	public getPositionValue(marketIndex: BN): BN {
		const userPosition =
			this.getUserPosition(marketIndex) || this.getEmptyPosition(marketIndex);
		const market = this.clearingHouse.getMarket(userPosition.marketIndex);
		return calculateBaseAssetValue(market, userPosition);
	}

	public getPositionSide(
		currentPosition: Pick<UserPosition, 'baseAssetAmount'>
	): PositionDirection | undefined {
		if (currentPosition.baseAssetAmount.gt(ZERO)) {
			return PositionDirection.LONG;
		} else if (currentPosition.baseAssetAmount.lt(ZERO)) {
			return PositionDirection.SHORT;
		} else {
			return undefined;
		}
	}

	/**
	 * calculates average exit price for closing 100% of position
	 * @returns : Precision MARK_PRICE_PRECISION
	 */
	public getPositionEstimatedExitPriceAndPnl(
		position: UserPosition,
		amountToClose?: BN
	): [BN, BN] {
		const market = this.clearingHouse.getMarket(position.marketIndex);

		const entryPrice = calculateEntryPrice(position);

		if (amountToClose) {
			if (amountToClose.eq(ZERO)) {
				return [calculateMarkPrice(market), ZERO];
			}
			position = {
				baseAssetAmount: amountToClose,
				lastCumulativeFundingRate: position.lastCumulativeFundingRate,
				marketIndex: position.marketIndex,
				quoteAssetAmount: position.quoteAssetAmount,
			} as UserPosition;
		}

		const baseAssetValue = calculateBaseAssetValue(market, position);
		if (position.baseAssetAmount.eq(ZERO)) {
			return [ZERO, ZERO];
		}

		const exitPrice = baseAssetValue
			.mul(AMM_TO_QUOTE_PRECISION_RATIO)
			.mul(MARK_PRICE_PRECISION)
			.div(position.baseAssetAmount.abs());

		const pnlPerBase = exitPrice.sub(entryPrice);
		const pnl = pnlPerBase
			.mul(position.baseAssetAmount)
			.div(MARK_PRICE_PRECISION)
			.div(AMM_TO_QUOTE_PRECISION_RATIO);

		return [exitPrice, pnl];
	}

	/**
	 * calculates current user leverage across all positions
	 * @returns : Precision TEN_THOUSAND
	 */
	public getLeverage(): BN {
		const totalCollateral = this.getTotalCollateral();
		const totalPositionValue = this.getTotalPositionValue();
		if (totalPositionValue.eq(ZERO) && totalCollateral.eq(ZERO)) {
			return ZERO;
		}
		return totalPositionValue.mul(TEN_THOUSAND).div(totalCollateral);
	}

	/**
	 * calculates max allowable leverage exceeding hitting requirement category
	 * @params category {Initial, Partial, Maintenance}
	 * @returns : Precision TEN_THOUSAND
	 */
	public getMaxLeverage(category?: 'Initial' | 'Partial' | 'Maintenance'): BN {
		const chState = this.clearingHouse.getStateAccount();
		let marginRatioCategory: BN;

		switch (category) {
			case 'Initial':
				marginRatioCategory = chState.marginRatioInitial;
				break;
			case 'Maintenance':
				marginRatioCategory = chState.marginRatioMaintenance;
				break;
			case 'Partial':
				marginRatioCategory = chState.marginRatioPartial;
				break;
			default:
				marginRatioCategory = chState.marginRatioInitial;
				break;
		}
		const maxLeverage = TEN_THOUSAND.mul(TEN_THOUSAND).div(marginRatioCategory);
		return maxLeverage;
	}

	/**
	 * calculates margin ratio: total collateral / |total position value|
	 * @returns : Precision TEN_THOUSAND
	 */
	public getMarginRatio(): BN {
		const totalPositionValue = this.getTotalPositionValue();

		if (totalPositionValue.eq(ZERO)) {
			return BN_MAX;
		}

		return this.getTotalCollateral().mul(TEN_THOUSAND).div(totalPositionValue);
	}

	public canBeLiquidated(): [boolean, BN] {
		const marginRatio = this.getMarginRatio();
		const canLiquidate = marginRatio.lte(PARTIAL_LIQUIDATION_RATIO);
		return [canLiquidate, marginRatio];
	}

	/**
	 * Checks if any user position cumulative funding differs from respective market cumulative funding
	 * @returns
	 */
	public needsToSettleFundingPayment(): boolean {
		const marketsAccount = this.clearingHouse.getMarketsAccount();
		for (const userPosition of this.getUserPositionsAccount().positions) {
			if (userPosition.baseAssetAmount.eq(ZERO)) {
				continue;
			}

			const market =
				marketsAccount.markets[userPosition.marketIndex.toNumber()];
			if (
				market.amm.cumulativeFundingRateLong.eq(
					userPosition.lastCumulativeFundingRate
				) ||
				market.amm.cumulativeFundingRateShort.eq(
					userPosition.lastCumulativeFundingRate
				)
			) {
				continue;
			}

			return true;
		}
		return false;
	}

	/**
	 * Calculate the liquidation price of a position, with optional parameter to calculate the liquidation price after a trade
	 * @param targetMarket
	 * @param positionBaseSizeChange // change in position size to calculate liquidation price for : Precision 10^13
	 * @param partial
	 * @returns Precision : MARK_PRICE_PRECISION
	 */
	public liquidationPriceOld(
		targetMarket: Pick<UserPosition, 'marketIndex'>,
		positionBaseSizeChange: BN = ZERO,
		partial = false
	): BN {
		// +/-(margin_ratio-liq_ratio) * price_now = price_liq
		// todo: margin_ratio is not symmetric on price action (both numer and denom change)
		// margin_ratio = collateral / base_asset_value

		/* example: assume BTC price is $40k (examine 10% up/down)
		
		if 10k deposit and levered 10x short BTC => BTC up $400 means:
		1. higher base_asset_value (+$4k)
		2. lower collateral (-$4k)
		3. (10k - 4k)/(100k + 4k) => 6k/104k => .0576

		for 10x long, BTC down $400:
		3. (10k - 4k) / (100k - 4k) = 6k/96k => .0625 */

		const currentPrice = calculateMarkPrice(
			this.clearingHouse.getMarket(targetMarket.marketIndex)
		);

		const totalCollateralUSDC = this.getTotalCollateral();

		// calculate the total position value ignoring any value from the target market of the trade
		const totalCurrentPositionValueIgnoringTargetUSDC =
			this.getTotalPositionValueExcludingMarket(targetMarket.marketIndex);

		const currentMarketPosition =
			this.getUserPosition(targetMarket.marketIndex) ||
			this.getEmptyPosition(targetMarket.marketIndex);

		const currentMarketPositionBaseSize = currentMarketPosition.baseAssetAmount;

		// calculate position for current market after trade
		const proposedMarketPosition: UserPosition = {
			marketIndex: targetMarket.marketIndex,
			baseAssetAmount: currentMarketPositionBaseSize.add(
				positionBaseSizeChange
			),
			lastCumulativeFundingRate: new BN(0),
			quoteAssetAmount: new BN(0),
			openOrders: new BN(0),
		};

		const market = this.clearingHouse.getMarket(
			proposedMarketPosition.marketIndex
		);

		const proposedMarketPositionValueUSDC = calculateBaseAssetValue(
			market,
			proposedMarketPosition
		);

		// total position value after trade
		const targetTotalPositionValueUSDC =
			totalCurrentPositionValueIgnoringTargetUSDC.add(
				proposedMarketPositionValueUSDC
			);

		let totalFreeCollateralUSDC = this.getTotalCollateral().sub(
			this.getTotalPositionValue()
				.mul(TEN_THOUSAND)
				.div(this.getMaxLeverage('Maintenance'))
		);

		if (partial) {
			totalFreeCollateralUSDC = this.getTotalCollateral().sub(
				this.getTotalPositionValue()
					.mul(TEN_THOUSAND)
					.div(this.getMaxLeverage('Partial'))
			);
		}

		// if the position value after the trade is less than total collateral, there is no liq price
		if (
			targetTotalPositionValueUSDC.lte(totalFreeCollateralUSDC) &&
			proposedMarketPosition.baseAssetAmount.gt(ZERO)
		) {
			return new BN(-1);
		}

		// get current margin ratio based on current collateral and proposed total position value
		let marginRatio;
		if (proposedMarketPositionValueUSDC.eq(ZERO)) {
			marginRatio = BN_MAX;
		} else {
			marginRatio = totalCollateralUSDC
				.mul(TEN_THOUSAND)
				.div(proposedMarketPositionValueUSDC);
		}

		let liqRatio = FULL_LIQUIDATION_RATIO;
		if (partial) {
			liqRatio = PARTIAL_LIQUIDATION_RATIO;
		}

		// sign of position in current market after the trade
		const baseAssetSignIsNeg = proposedMarketPosition.baseAssetAmount.isNeg();

		let pctChange = marginRatio.abs().sub(liqRatio);
		// if user is short, higher price is liq
		if (baseAssetSignIsNeg) {
			pctChange = pctChange.add(TEN_THOUSAND);
		} else {
			if (TEN_THOUSAND.lte(pctChange)) {
				// no liquidation price, position is a fully/over collateralized long
				// handle as NaN on UI
				return new BN(-1);
			}
			pctChange = TEN_THOUSAND.sub(pctChange);
		}

		const liqPrice = currentPrice.mul(pctChange).div(TEN_THOUSAND);

		return liqPrice;
	}

	/**
	 * Calculate the liquidation price of a position, with optional parameter to calculate the liquidation price after a trade
	 * @param targetMarket
	 * @param positionBaseSizeChange // change in position size to calculate liquidation price for : Precision 10^13
	 * @param partial
	 * @returns Precision : MARK_PRICE_PRECISION
	 */
	public liquidationPrice(
		targetMarket: Pick<UserPosition, 'marketIndex'>,
		positionBaseSizeChange: BN = ZERO,
		partial = false
	): BN {
		// solves formula for example calc below

		/* example: assume BTC price is $40k (examine 10% up/down)

        if 10k deposit and levered 10x short BTC => BTC up $400 means:
        1. higher base_asset_value (+$4k)
        2. lower collateral (-$4k)
        3. (10k - 4k)/(100k + 4k) => 6k/104k => .0576

        for 10x long, BTC down $400:
        3. (10k - 4k) / (100k - 4k) = 6k/96k => .0625 */

		const tc = this.getTotalCollateral();
		const tpv = this.getTotalPositionValue();

		const partialLev = 16;
		const maintLev = 20;

		const thisLev = partial ? new BN(partialLev) : new BN(maintLev);

		// calculate the total position value ignoring any value from the target market of the trade
		const totalCurrentPositionValueIgnoringTargetUSDC =
			this.getTotalPositionValueExcludingMarket(targetMarket.marketIndex);

		const currentMarketPosition =
			this.getUserPosition(targetMarket.marketIndex) ||
			this.getEmptyPosition(targetMarket.marketIndex);

		const currentMarketPositionBaseSize = currentMarketPosition.baseAssetAmount;

		const proposedBaseAssetAmount = currentMarketPositionBaseSize.add(
			positionBaseSizeChange
		);

		// calculate position for current market after trade
		const proposedMarketPosition: UserPosition = {
			marketIndex: targetMarket.marketIndex,
			baseAssetAmount: proposedBaseAssetAmount,
			lastCumulativeFundingRate:
				currentMarketPosition.lastCumulativeFundingRate,
			quoteAssetAmount: new BN(0),
			openOrders: new BN(0),
		};

		const market = this.clearingHouse.getMarket(
			proposedMarketPosition.marketIndex
		);

		const proposedMarketPositionValueUSDC = calculateBaseAssetValue(
			market,
			proposedMarketPosition
		);

		// total position value after trade
		const targetTotalPositionValueUSDC =
			totalCurrentPositionValueIgnoringTargetUSDC.add(
				proposedMarketPositionValueUSDC
			);

		let totalFreeCollateralUSDC = tc.sub(
			totalCurrentPositionValueIgnoringTargetUSDC
				.mul(TEN_THOUSAND)
				.div(this.getMaxLeverage('Maintenance'))
		);

		if (partial) {
			totalFreeCollateralUSDC = tc.sub(
				totalCurrentPositionValueIgnoringTargetUSDC
					.mul(TEN_THOUSAND)
					.div(this.getMaxLeverage('Partial'))
			);
		}

		let priceDelt;
		if (proposedBaseAssetAmount.lt(ZERO)) {
			priceDelt = tc
				.mul(thisLev)
				.sub(tpv)
				.mul(PRICE_TO_QUOTE_PRECISION)
				.div(thisLev.add(new BN(1)));
		} else {
			priceDelt = tc
				.mul(thisLev)
				.sub(tpv)
				.mul(PRICE_TO_QUOTE_PRECISION)
				.div(thisLev.sub(new BN(1)));
		}

		let currentPrice;
		if (positionBaseSizeChange.eq(ZERO)) {
			currentPrice = calculateMarkPrice(
				this.clearingHouse.getMarket(targetMarket.marketIndex)
			);
		} else {
			const direction = positionBaseSizeChange.gt(ZERO)
				? PositionDirection.LONG
				: PositionDirection.SHORT;
			currentPrice = calculateTradeSlippage(
				direction,
				positionBaseSizeChange.abs(),
				this.clearingHouse.getMarket(targetMarket.marketIndex),
				'base'
			)[3]; // newPrice after swap
		}

		// if the position value after the trade is less than total collateral, there is no liq price
		if (
			targetTotalPositionValueUSDC.lte(totalFreeCollateralUSDC) &&
			proposedMarketPosition.baseAssetAmount.gt(ZERO)
		) {
			return new BN(-1);
		}

		if (proposedBaseAssetAmount.eq(ZERO)) return new BN(-1);

		const eatMargin2 = priceDelt
			.mul(AMM_RESERVE_PRECISION)
			.div(proposedBaseAssetAmount);

		if (eatMargin2.gt(currentPrice)) {
			return new BN(-1);
		}

		const liqPrice = currentPrice.sub(eatMargin2);
		return liqPrice;
	}

	/**
	 * Calculates the estimated liquidation price for a position after closing a quote amount of the position.
	 * @param positionMarketIndex
	 * @param closeQuoteAmount
	 * @returns : Precision MARK_PRICE_PRECISION
	 */
	public liquidationPriceAfterClose(
		positionMarketIndex: BN,
		closeQuoteAmount: BN
	): BN {
		const currentPosition =
			this.getUserPosition(positionMarketIndex) ||
			this.getEmptyPosition(positionMarketIndex);

		const closeBaseAmount = currentPosition.baseAssetAmount
			.mul(closeQuoteAmount)
			.div(currentPosition.quoteAssetAmount)
			.add(
				currentPosition.baseAssetAmount
					.mul(closeQuoteAmount)
					.mod(currentPosition.quoteAssetAmount)
			)
			.neg();

		return this.liquidationPrice(
			{
				marketIndex: positionMarketIndex,
			},
			closeBaseAmount
		);
	}

	/**
	 * Get the maximum trade size for a given market, taking into account the user's current leverage, positions, collateral, etc.
	 * @param marketIndex
	 * @param tradeSide
	 * @param userMaxLeverageSetting - leverage : Precision TEN_THOUSAND
	 * @returns tradeSizeAllowed : Precision QUOTE_PRECISION
	 */
	public getMaxTradeSizeUSDC(
		targetMarketIndex: BN,
		tradeSide: PositionDirection,
		userMaxLeverageSetting: BN
	): BN {
		// inline function which get's the current position size on the opposite side of the target trade
		const getOppositePositionValueUSDC = () => {
			if (!currentPosition) return ZERO;

			const side = tradeSide === PositionDirection.SHORT ? 'short' : 'long';

			if (side === 'long' && currentPosition?.baseAssetAmount.isNeg()) {
				return this.getPositionValue(targetMarketIndex);
			} else if (
				side === 'short' &&
				!currentPosition?.baseAssetAmount.isNeg()
			) {
				return this.getPositionValue(targetMarketIndex);
			}

			return ZERO;
		};

		const currentPosition =
			this.getUserPosition(targetMarketIndex) ||
			this.getEmptyPosition(targetMarketIndex);

		// get current leverage
		const currentLeverage = this.getLeverage();

		// remaining leverage
		// let remainingLeverage = userMaxLeverageSetting;

		const remainingLeverage = BN.max(
			userMaxLeverageSetting.sub(currentLeverage),
			ZERO
		);

		// get total collateral
		const totalCollateral = this.getTotalCollateral();

		// position side allowed based purely on current leverage
		let maxPositionSize = remainingLeverage
			.mul(totalCollateral)
			.div(TEN_THOUSAND);

		// add any position we have on the opposite side of the current trade, because we can "flip" the size of this position without taking any extra leverage.
		const oppositeSizeValueUSDC = getOppositePositionValueUSDC();

		maxPositionSize = maxPositionSize.add(oppositeSizeValueUSDC.mul(new BN(2)));

		// subtract oneMillionth of maxPositionSize
		// => to avoid rounding errors when taking max leverage
		const oneMilli = maxPositionSize.div(QUOTE_PRECISION);
		return maxPositionSize.sub(oneMilli);
	}

	// TODO - should this take the price impact of the trade into account for strict accuracy?

	/**
	 * Returns the leverage ratio for the account after adding (or subtracting) the given quote size to the given position
	 * @param targetMarketIndex
	 * @param positionMarketIndex
	 * @param tradeQuoteAmount
	 * @returns leverageRatio : Precision TEN_THOUSAND
	 */
	public accountLeverageRatioAfterTrade(
		targetMarketIndex: BN,
		tradeQuoteAmount: BN,
		tradeSide: PositionDirection
	): BN {
		const currentPosition =
			this.getUserPosition(targetMarketIndex) ||
			this.getEmptyPosition(targetMarketIndex);

		let currentPositionQuoteAmount = this.getPositionValue(targetMarketIndex);

		const currentSide =
			currentPosition && currentPosition.baseAssetAmount.isNeg()
				? PositionDirection.SHORT
				: PositionDirection.LONG;

		if (currentSide === PositionDirection.SHORT)
			currentPositionQuoteAmount = currentPositionQuoteAmount.neg();

		if (tradeSide === PositionDirection.SHORT)
			tradeQuoteAmount = tradeQuoteAmount.neg();

		const currentMarketPositionAfterTrade = currentPositionQuoteAmount
			.add(tradeQuoteAmount)
			.abs();

		const totalPositionAfterTradeExcludingTargetMarket =
			this.getTotalPositionValueExcludingMarket(targetMarketIndex);
		const newLeverage = currentMarketPositionAfterTrade
			.add(totalPositionAfterTradeExcludingTargetMarket)
			.abs()
			.mul(TEN_THOUSAND)
			.div(this.getTotalCollateral());

		return newLeverage;
	}

	/**
	 * Calculates how much fee will be taken for a given sized trade
	 * @param quoteAmount
	 * @returns feeForQuote : Precision QUOTE_PRECISION
	 */
	public calculateFeeForQuoteAmount(quoteAmount: BN): BN {
		const feeStructure = this.clearingHouse.getStateAccount().feeStructure;

		return quoteAmount
			.mul(feeStructure.feeNumerator)
			.div(feeStructure.feeDenominator);
	}

	/**
	 * Get the total position value, excluding any position coming from the given target market
	 * @param marketToIgnore
	 * @returns positionValue : Precision QUOTE_PRECISION
	 */
	private getTotalPositionValueExcludingMarket(marketToIgnore: BN): BN {
		const currentMarketPosition =
			this.getUserPosition(marketToIgnore) ||
			this.getEmptyPosition(marketToIgnore);

		let currentMarketPositionValueUSDC = ZERO;
		if (currentMarketPosition) {
			const market = this.clearingHouse.getMarket(
				currentMarketPosition.marketIndex
			);
			currentMarketPositionValueUSDC = calculateBaseAssetValue(
				market,
				currentMarketPosition
			);
		}

		return this.getTotalPositionValue().sub(currentMarketPositionValueUSDC);
	}

	public canFillOrder(order: Order): boolean {
		const userAccount = this.getUserAccount();
		const userPositionsAccount = this.getUserPositionsAccount();
		const userPosition = this.getUserPosition(order.marketIndex);
		const market = this.clearingHouse.getMarket(order.marketIndex);

		if (isEmptyPosition(userPosition)) {
			return false;
		}

		const newState = calculateNewStateAfterOrder(
			userAccount,
			userPosition,
			market,
			order
		);
		if (newState === null) {
			return false;
		}
		const [userAccountAfter, userPositionAfter, marketAfter] = newState;

		const totalPositionValue = userPositionsAccount.positions.reduce(
			(positionValue, marketPosition) => {
				let market = this.clearingHouse.getMarket(marketPosition.marketIndex);
				if (marketPosition.marketIndex.eq(order.marketIndex)) {
					market = marketAfter;
					marketPosition = userPositionAfter;
				}

				return positionValue.add(
					calculateBaseAssetValue(market, marketPosition)
				);
			},
			ZERO
		);

		if (totalPositionValue.eq(ZERO)) {
			return true;
		}

		const unrealizedPnL = userPositionsAccount.positions.reduce(
			(pnl, marketPosition) => {
				let market = this.clearingHouse.getMarket(marketPosition.marketIndex);
				pnl = pnl.add(
					calculatePositionFundingPNL(market, marketPosition).div(
						PRICE_TO_QUOTE_PRECISION
					)
				);

				if (marketPosition.marketIndex.eq(order.marketIndex)) {
					market = marketAfter;
					marketPosition = userPositionAfter;
				}

				// update
				return pnl.add(calculatePositionPNL(market, marketPosition, false));
			},
			ZERO
		);
		const totalCollateral = userAccountAfter.collateral.add(unrealizedPnL);

		const marginRatioAfter = totalCollateral
			.mul(TEN_THOUSAND)
			.div(totalPositionValue);

		const marginRatioInitial =
			this.clearingHouse.getStateAccount().marginRatioInitial;
		return marginRatioAfter.gte(marginRatioInitial);
	}
}
