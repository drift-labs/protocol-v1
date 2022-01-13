import {
	CurveHistoryAccount,
	DepositHistoryAccount,
	FundingPaymentHistoryAccount,
	FundingRateHistoryAccount,
	LiquidationHistoryAccount,
	MarketsAccount,
	StateAccount,
	TradeHistoryAccount,
	UserAccount,
	UserPositionsAccount,
} from '../types';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';

export interface AccountSubscriber<T> {
	isSubscribed: boolean;
	data?: T;
	subscribe(onChange: (data: T) => void): Promise<void>;
	fetch(): Promise<void>;
	unsubscribe(): void;
}

export class NotSubscribedError extends Error {
	name = 'NotSubscribedError';
}

export interface ClearingHouseAccountEvents {
	stateAccountUpdate: (payload: StateAccount) => void;
	marketsAccountUpdate: (payload: MarketsAccount) => void;
	fundingPaymentHistoryAccountUpdate: (
		payload: FundingPaymentHistoryAccount
	) => void;
	fundingRateHistoryAccountUpdate: (payload: FundingRateHistoryAccount) => void;
	tradeHistoryAccountUpdate: (payload: TradeHistoryAccount) => void;
	liquidationHistoryAccountUpdate: (payload: LiquidationHistoryAccount) => void;
	depositHistoryAccountUpdate: (payload: DepositHistoryAccount) => void;
	curveHistoryAccountUpdate: (payload: CurveHistoryAccount) => void;
	update: void;
	fetched: void;
	fetchedAccount: SubscribableClearingHouseAccountTypes;
}

export type OptionalSubscribableClearingHouseAccountTypes =
	| 'tradeHistoryAccount'
	| 'depositHistoryAccount'
	| 'fundingPaymentHistoryAccount'
	| 'fundingRateHistoryAccount'
	| 'curveHistoryAccount'
	| 'liquidationHistoryAccount';

export type SubscribableClearingHouseAccountTypes =
	| 'stateAccount'
	| 'marketsAccount'
	| OptionalSubscribableClearingHouseAccountTypes;

export type SubscribableUserAccountTypes =
	| 'userAccount'
	| 'userPositionsAccount';

export interface ClearingHouseAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseAccountEvents>;
	isSubscribed: boolean;

	subscribe(
		optionalSubscriptions?: OptionalSubscribableClearingHouseAccountTypes[]
	): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	getStateAccount(): StateAccount;
	getMarketsAccount(): MarketsAccount;
	getTradeHistoryAccount(): TradeHistoryAccount;
	getDepositHistoryAccount(): DepositHistoryAccount;
	getFundingPaymentHistoryAccount(): FundingPaymentHistoryAccount;
	getFundingRateHistoryAccount(): FundingRateHistoryAccount;
	getCurveHistoryAccount(): CurveHistoryAccount;
	getLiquidationHistoryAccount(): LiquidationHistoryAccount;
}

export interface UserAccountEvents {
	userAccountData: (payload: UserAccount) => void;
	userPositionsData: (payload: UserPositionsAccount) => void;
	update: void;
	fetched: void;
	fetchedAccount: SubscribableUserAccountTypes;
}

export interface UserAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	getUserAccount(): UserAccount;
	getUserPositionsAccount(): UserPositionsAccount;
}

export interface PollingUserAccountSubscriber extends UserAccountSubscriber {
	startPolling(account: SubscribableUserAccountTypes): boolean;
	stopPolling(account: SubscribableUserAccountTypes): boolean;
	setPollingRate(account: SubscribableUserAccountTypes, rate: number): void;
}

export interface PollingClearingHouseAccountSubscriber
	extends ClearingHouseAccountSubscriber {
	startPolling(account: SubscribableClearingHouseAccountTypes): boolean;
	stopPolling(account: SubscribableClearingHouseAccountTypes): boolean;
	setPollingRate(
		account: SubscribableClearingHouseAccountTypes,
		rate: number
	): void;
}
