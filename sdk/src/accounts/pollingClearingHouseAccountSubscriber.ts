import {
	ClearingHouseAccountSubscriber,
	ClearingHouseAccountEvents,
	ClearingHouseAccountTypes,
} from './types';
import { NotSubscribedError } from './types';
import {
	DepositHistoryAccount,
	ExtendedCurveHistoryAccount,
	FundingPaymentHistoryAccount,
	FundingRateHistoryAccount,
	LiquidationHistoryAccount,
	MarketsAccount,
	StateAccount,
	TradeHistoryAccount,
} from '../types';
import { Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { getClearingHouseStateAccountPublicKey } from '../addresses';
import { PublicKey } from '@solana/web3.js';

type AccountValue<T> = {
	raw: string;
	account: T;
};

type AccountToPoll = {
	key: string;
	publicKey: PublicKey;
	eventType: string;
};

export class PollingClearingHouseAccountSubscriber
	implements ClearingHouseAccountSubscriber
{
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseAccountEvents>;
	accountsToPoll: AccountToPoll[];

	lastSlot: number;
	pollingFrequency: number;
	intervalId?: NodeJS.Timer;

	state?: AccountValue<StateAccount>;
	markets?: AccountValue<MarketsAccount>;
	tradeHistory?: AccountValue<TradeHistoryAccount>;
	depositHistory?: AccountValue<DepositHistoryAccount>;
	fundingPaymentHistory?: AccountValue<FundingPaymentHistoryAccount>;
	fundingRateHistory?: AccountValue<FundingRateHistoryAccount>;
	liquidationHistory?: AccountValue<LiquidationHistoryAccount>;
	extendedCurveHistory: AccountValue<ExtendedCurveHistoryAccount>;

	optionalExtraSubscriptions: ClearingHouseAccountTypes[] = [];

	private isSubscribing = false;
	private subscriptionPromise: Promise<boolean>;
	private subscriptionPromiseResolver: (val: boolean) => void;

	public constructor(program: Program, pollingFrequency = 1000) {
		this.isSubscribed = false;
		this.program = program;
		this.eventEmitter = new EventEmitter();
		this.lastSlot = 0;
		this.pollingFrequency = pollingFrequency;
	}

	public async subscribe(
		optionalSubscriptions?: ClearingHouseAccountTypes[]
	): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		if (this.isSubscribing) {
			return await this.subscriptionPromise;
		}

		this.optionalExtraSubscriptions = optionalSubscriptions;

		this.isSubscribing = true;

		this.subscriptionPromise = new Promise((res) => {
			this.subscriptionPromiseResolver = res;
		});

		await this.updateAccountsToPoll();
		await this.pollAccounts();

		this.intervalId = setInterval(
			this.pollAccounts.bind(this),
			this.pollingFrequency
		);

		this.isSubscribing = false;
		this.isSubscribed = true;
		this.subscriptionPromiseResolver(true);

		return true;
	}

	async updateAccountsToPoll(): Promise<void> {
		if (this.accountsToPoll && this.accountsToPoll.length > 0) {
			return;
		}

		const statePublicKey = await getClearingHouseStateAccountPublicKey(
			this.program.programId
		);
		// @ts-ignore
		const state: StateAccount = await this.program.account.state.fetch(
			statePublicKey
		);
		const marketsPublicKey = state.markets;

		const accountsToPoll: AccountToPoll[] = [
			{
				key: 'state',
				publicKey: statePublicKey,
				eventType: 'stateAccountUpdate',
			},
			{
				key: 'markets',
				publicKey: marketsPublicKey,
				eventType: 'marketsAccountUpdate',
			},
		];

		if (this.optionalExtraSubscriptions?.includes('tradeHistoryAccount')) {
			accountsToPoll.push({
				key: 'tradeHistory',
				publicKey: state.tradeHistory,
				eventType: 'tradeHistoryAccountUpdate',
			});
		}

		if (this.optionalExtraSubscriptions?.includes('depositHistoryAccount')) {
			accountsToPoll.push({
				key: 'depositHistory',
				publicKey: state.depositHistory,
				eventType: 'depositHistoryAccountUpdate',
			});
		}

		if (
			this.optionalExtraSubscriptions?.includes('fundingPaymentHistoryAccount')
		) {
			accountsToPoll.push({
				key: 'fundingPaymentHistory',
				publicKey: state.fundingPaymentHistory,
				eventType: 'fundingPaymentHistoryAccountUpdate',
			});
		}

		if (
			this.optionalExtraSubscriptions?.includes('fundingRateHistoryAccount')
		) {
			accountsToPoll.push({
				key: 'fundingRateHistory',
				publicKey: state.fundingRateHistory,
				eventType: 'fundingRateHistoryAccountUpdate',
			});
		}

		if (this.optionalExtraSubscriptions?.includes('curveHistoryAccount')) {
			accountsToPoll.push({
				key: 'extendedCurveHistory',
				publicKey: state.extendedCurveHistory,
				eventType: 'curveHistoryAccountUpdate',
			});
		}

		if (
			this.optionalExtraSubscriptions?.includes('liquidationHistoryAccount')
		) {
			accountsToPoll.push({
				key: 'liquidationHistory',
				publicKey: state.liquidationHistory,
				eventType: 'liquidationHistoryAccountUpdate',
			});
		}

		this.accountsToPoll = accountsToPoll;
	}

	capitalize(value: string): string {
		return value[0].toUpperCase() + value.slice(1).toLowerCase();
	}

	async pollAccounts(): Promise<void> {
		const args = [
			this.accountsToPoll.map((accountToPoll) =>
				accountToPoll.publicKey.toBase58()
			),
			{ commitment: 'recent' },
		];

		// @ts-ignore
		const rpcResponse = await this.program.provider.connection._rpcRequest(
			'getMultipleAccounts',
			args
		);

		const newSlot = rpcResponse.result.context.slot;
		if (newSlot <= this.lastSlot) {
			return;
		}

		this.lastSlot = newSlot;

		this.accountsToPoll.forEach((accountToPoll, i) => {
			const raw: string = rpcResponse.result.value[i].data[0];
			const dataType = rpcResponse.result.value[i].data[1];
			const buffer = Buffer.from(raw, dataType);

			const account = this.program.account[
				accountToPoll.key
			].coder.accounts.decode(
				// @ts-ignore
				this.capitalize(accountToPoll.key),
				buffer
			);

			const newValue = {
				raw,
				account,
			};
			const oldValue = this[accountToPoll.key];

			if (oldValue === undefined || oldValue.raw !== newValue.raw) {
				this[accountToPoll.key] = newValue;
				// @ts-ignore
				this.eventEmitter.emit(accountToPoll.eventType, newValue.account);
				this.eventEmitter.emit('update');
			}
		});
	}

	public async fetch(): Promise<void> {
		await this.pollAccounts();
	}

	public async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		clearInterval(this.intervalId);
		this.accountsToPoll = [];
		this.intervalId = undefined;
		this.isSubscribed = false;
	}

	assertIsSubscribed(): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}
	}

	assertOptionalIsSubscribed(
		optionalSubscription: ClearingHouseAccountTypes
	): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}

		if (!this.optionalExtraSubscriptions.includes(optionalSubscription)) {
			throw new NotSubscribedError(
				`You need to subscribe to the optional Clearing House account "${optionalSubscription}" to use this method`
			);
		}
	}

	public getStateAccount(): StateAccount {
		this.assertIsSubscribed();
		return this.state.account;
	}

	public getMarketsAccount(): MarketsAccount {
		this.assertIsSubscribed();
		return this.markets.account;
	}

	public getTradeHistoryAccount(): TradeHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('tradeHistoryAccount');
		return this.tradeHistory.account;
	}

	public getDepositHistoryAccount(): DepositHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('depositHistoryAccount');
		return this.depositHistory.account;
	}

	public getFundingPaymentHistoryAccount(): FundingPaymentHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('fundingPaymentHistoryAccount');
		return this.fundingPaymentHistory.account;
	}

	public getFundingRateHistoryAccount(): FundingRateHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('fundingRateHistoryAccount');
		return this.fundingRateHistory.account;
	}

	public getCurveHistoryAccount(): ExtendedCurveHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('curveHistoryAccount');
		return this.extendedCurveHistory.account;
	}

	public getLiquidationHistoryAccount(): LiquidationHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('liquidationHistoryAccount');
		return this.liquidationHistory.account;
	}
}
