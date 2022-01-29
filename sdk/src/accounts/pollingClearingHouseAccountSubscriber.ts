import { PublicKey } from '@solana/web3.js';
import {
	ClearingHouseAccountEvents,
	ClearingHouseAccountSubscriber,
	ClearingHouseAccountTypes,
	NotSubscribedError,
} from './types';
import { Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
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
import { getClearingHouseStateAccountPublicKey } from '../addresses';
import { BulkAccountLoader } from './bulkAccountLoader';

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
	accountLoader: BulkAccountLoader;
	accountsToPoll: AccountToPoll[];

	state?: StateAccount;
	markets?: MarketsAccount;
	tradeHistory?: TradeHistoryAccount;
	depositHistory?: DepositHistoryAccount;
	fundingPaymentHistory?: FundingPaymentHistoryAccount;
	fundingRateHistory?: FundingRateHistoryAccount;
	liquidationHistory?: LiquidationHistoryAccount;
	extendedCurveHistory: ExtendedCurveHistoryAccount;

	optionalExtraSubscriptions: ClearingHouseAccountTypes[] = [];

	private isSubscribing = false;
	private subscriptionPromise: Promise<boolean>;
	private subscriptionPromiseResolver: (val: boolean) => void;

	public constructor(program: Program, accountLoader: BulkAccountLoader) {
		this.isSubscribed = false;
		this.program = program;
		this.eventEmitter = new EventEmitter();
		this.accountLoader = accountLoader;
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
		await this.addToAccountLoader();
		this.accountLoader.startPolling();
		await this.accountLoader.load();
		this.eventEmitter.emit('update');

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

	async addToAccountLoader(): Promise<void> {
		this.accountsToPoll.forEach((accountToPoll) => {
			const onChange = (buffer: Buffer) => {
				const account = this.program.account[
					accountToPoll.key
				].coder.accounts.decode(this.capitalize(accountToPoll.key), buffer);
				// @ts-ignore
				this.eventEmitter.emit(accountToPoll.eventType, account);
				this.eventEmitter.emit('update');
				this[accountToPoll.key] = account;
			};
			onChange.bind(this);
			this.accountLoader.addAccount({
				publicKey: accountToPoll.publicKey,
				onChange,
			});
		});
	}

	public async fetch(): Promise<void> {
		await this.accountLoader.load();
	}

	public async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		for (const accountToPoll of this.accountsToPoll) {
			this.accountLoader.removeAccount(accountToPoll.publicKey);
		}

		this.accountsToPoll = [];
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
		return this.state;
	}

	public getMarketsAccount(): MarketsAccount {
		this.assertIsSubscribed();
		return this.markets;
	}

	public getTradeHistoryAccount(): TradeHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('tradeHistoryAccount');
		return this.tradeHistory;
	}

	public getDepositHistoryAccount(): DepositHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('depositHistoryAccount');
		return this.depositHistory;
	}

	public getFundingPaymentHistoryAccount(): FundingPaymentHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('fundingPaymentHistoryAccount');
		return this.fundingPaymentHistory;
	}

	public getFundingRateHistoryAccount(): FundingRateHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('fundingRateHistoryAccount');
		return this.fundingRateHistory;
	}

	public getCurveHistoryAccount(): ExtendedCurveHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('curveHistoryAccount');
		return this.extendedCurveHistory;
	}

	public getLiquidationHistoryAccount(): LiquidationHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('liquidationHistoryAccount');
		return this.liquidationHistory;
	}
}
