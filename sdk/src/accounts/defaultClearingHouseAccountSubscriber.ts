import {
	PollingClearingHouseAccountSubscriber,
	ClearingHouseAccountEvents,
	OptionalSubscribableClearingHouseAccountTypes,
	SubscribableClearingHouseAccountTypes,
} from './types';
import { NotSubscribedError } from './types';
import {
	CurveHistoryAccount,
	DepositHistoryAccount,
	FundingPaymentHistoryAccount,
	FundingRateHistoryAccount,
	LiquidationHistoryAccount,
	MarketsAccount,
	StateAccount,
	SubscribableAccount,
	TradeHistoryAccount,
} from '../types';
import { Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { getClearingHouseStateAccountPublicKey } from '../addresses';
import { PollingWebSocketAccountSubscriber } from './pollingWebSocketAccountSubscriber';

export class DefaultClearingHouseAccountSubscriber
	implements PollingClearingHouseAccountSubscriber
{
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseAccountEvents>;

	subscribers: Map<
		SubscribableClearingHouseAccountTypes,
		PollingWebSocketAccountSubscriber<
			SubscribableAccount,
			SubscribableClearingHouseAccountTypes
		>
	> = new Map<
		SubscribableClearingHouseAccountTypes,
		PollingWebSocketAccountSubscriber<
			SubscribableAccount,
			SubscribableClearingHouseAccountTypes
		>
	>();

	private isSubscribing = false;
	private subscriptionPromise: Promise<boolean>;
	private subscriptionPromiseResolver: (val: boolean) => void;

	public constructor(program: Program) {
		this.isSubscribed = false;
		this.program = program;
		this.eventEmitter = new EventEmitter();
	}

	startPolling(account: SubscribableClearingHouseAccountTypes): boolean {
		if (!this.subscribers.has(account)) {
			throw new Error('could not find subscriber ' + account);
		}
		if (!this.subscribers.get(account).isSubscribed) {
			throw new Error('account is not subscribed ' + account);
		}

		return this.subscribers.get(account).startPolling((accountType) => {
			this.eventEmitter.emit('fetchedAccount', accountType);
		});
	}

	stopPolling(account: SubscribableClearingHouseAccountTypes): boolean {
		return this.subscribers.get(account).stopPolling();
	}

	setPollingRate(
		account: SubscribableClearingHouseAccountTypes,
		rate: number
	): void {
		this.subscribers.get(account).setPollingRate(rate);
	}

	public async subscribe(
		optionalSubscriptions: Array<OptionalSubscribableClearingHouseAccountTypes> = []
	): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		if (this.isSubscribing) {
			return await this.subscriptionPromise;
		}

		this.isSubscribing = true;

		this.subscriptionPromise = new Promise((res) => {
			this.subscriptionPromiseResolver = res;
		});

		const statePublicKey = await getClearingHouseStateAccountPublicKey(
			this.program.programId
		);

		// create and activate main state account subscription
		this.subscribers.set(
			'stateAccount',
			new PollingWebSocketAccountSubscriber(
				'stateAccount',
				'state',
				this.program,
				statePublicKey
			)
		);
		await this.subscribers
			.get('stateAccount')
			.subscribe((data: StateAccount) => {
				this.eventEmitter.emit('stateAccountUpdate', data);
				this.eventEmitter.emit('update');
			});

		const state = this.subscribers.get('stateAccount').data as StateAccount;

		this.subscribers.set(
			'marketsAccount',
			new PollingWebSocketAccountSubscriber(
				'marketsAccount',
				'markets',
				this.program,
				state.markets
			)
		);

		await this.subscribers
			.get('marketsAccount')
			.subscribe((data: MarketsAccount) => {
				this.eventEmitter.emit('marketsAccountUpdate', data);
				this.eventEmitter.emit('update');
			});

		// create subscribers for other state accounts

		this.subscribers.set(
			'tradeHistoryAccount',
			new PollingWebSocketAccountSubscriber(
				'tradeHistoryAccount',
				'tradeHistory',
				this.program,
				state.tradeHistory
			)
		);

		this.subscribers.set(
			'depositHistoryAccount',
			new PollingWebSocketAccountSubscriber(
				'depositHistoryAccount',
				'depositHistory',
				this.program,
				state.depositHistory
			)
		);

		this.subscribers.set(
			'fundingPaymentHistoryAccount',
			new PollingWebSocketAccountSubscriber(
				'fundingPaymentHistoryAccount',
				'fundingPaymentHistory',
				this.program,
				state.fundingPaymentHistory
			)
		);

		this.subscribers.set(
			'fundingRateHistoryAccount',
			new PollingWebSocketAccountSubscriber(
				'fundingRateHistoryAccount',
				'fundingRateHistory',
				this.program,
				state.fundingRateHistory
			)
		);

		this.subscribers.set(
			'liquidationHistoryAccount',
			new PollingWebSocketAccountSubscriber(
				'liquidationHistoryAccount',
				'liquidationHistory',
				this.program,
				state.liquidationHistory
			)
		);

		this.subscribers.set(
			'curveHistoryAccount',
			new PollingWebSocketAccountSubscriber(
				'curveHistoryAccount',
				'curveHistory',
				this.program,
				state.curveHistory
			)
		);

		await Promise.all(
			optionalSubscriptions.map((accountType) => {
				switch (accountType) {
					case 'curveHistoryAccount':
						return this.subscribers.get(accountType).subscribe((data) => {
							this.eventEmitter.emit(
								'curveHistoryAccountUpdate',
								data as CurveHistoryAccount
							);
							this.eventEmitter.emit('update');
						});
					case 'depositHistoryAccount':
						return this.subscribers.get(accountType).subscribe((data) => {
							this.eventEmitter.emit(
								'depositHistoryAccountUpdate',
								data as DepositHistoryAccount
							);
							this.eventEmitter.emit('update');
						});

					case 'fundingPaymentHistoryAccount':
						return this.subscribers.get(accountType).subscribe((data) => {
							this.eventEmitter.emit(
								'fundingPaymentHistoryAccountUpdate',
								data as FundingPaymentHistoryAccount
							);
							this.eventEmitter.emit('update');
						});
					case 'fundingRateHistoryAccount':
						return this.subscribers.get(accountType).subscribe((data) => {
							this.eventEmitter.emit(
								'fundingRateHistoryAccountUpdate',
								data as FundingRateHistoryAccount
							);
							this.eventEmitter.emit('update');
						});
					case 'liquidationHistoryAccount':
						return this.subscribers.get(accountType).subscribe((data) => {
							this.eventEmitter.emit(
								'liquidationHistoryAccountUpdate',
								data as LiquidationHistoryAccount
							);
							this.eventEmitter.emit('update');
						});
					case 'tradeHistoryAccount':
						return this.subscribers.get(accountType).subscribe((data) => {
							this.eventEmitter.emit(
								'tradeHistoryAccountUpdate',
								data as TradeHistoryAccount
							);
							this.eventEmitter.emit('update');
						});
				}
			})
		);

		this.eventEmitter.emit('update');

		this.isSubscribing = false;
		this.isSubscribed = true;
		this.subscriptionPromiseResolver(true);

		return true;
	}

	public async fetch(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await Promise.all(
			[...this.subscribers.values()]
				.filter((accountSubscriber) => accountSubscriber.isSubscribed)
				.map((accountSubscriber) => {
					return accountSubscriber.fetch();
				})
		);

		this.eventEmitter.emit('fetched');
	}

	public async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await Promise.all(
			[...this.subscribers.values()]
				.filter((accountSubscriber) => accountSubscriber.isSubscribed)
				.map((accountSubscriber) => {
					return accountSubscriber.unsubscribe();
				})
		);

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
		optionalSubscription: OptionalSubscribableClearingHouseAccountTypes
	): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		}

		if (!this.subscribers.has(optionalSubscription)) {
			throw new NotSubscribedError(
				`You need to subscribe to the optional Clearing House account "${optionalSubscription}" to use this method`
			);
		}
	}

	public getStateAccount(): StateAccount {
		this.assertIsSubscribed();
		return this.subscribers.get('stateAccount').data as StateAccount;
	}

	public getMarketsAccount(): MarketsAccount {
		this.assertIsSubscribed();
		return this.subscribers.get('marketsAccount').data as MarketsAccount;
	}

	public getTradeHistoryAccount(): TradeHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('tradeHistoryAccount');
		return this.subscribers.get('tradeHistoryAccount')
			.data as TradeHistoryAccount;
	}

	public getDepositHistoryAccount(): DepositHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('depositHistoryAccount');
		return this.subscribers.get('depositHistoryAccount')
			.data as DepositHistoryAccount;
	}

	public getFundingPaymentHistoryAccount(): FundingPaymentHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('fundingPaymentHistoryAccount');
		return this.subscribers.get('fundingPaymentHistoryAccount')
			.data as FundingPaymentHistoryAccount;
	}

	public getFundingRateHistoryAccount(): FundingRateHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('fundingRateHistoryAccount');
		return this.subscribers.get('fundingRateHistoryAccount')
			.data as FundingRateHistoryAccount;
	}

	public getCurveHistoryAccount(): CurveHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('curveHistoryAccount');
		return this.subscribers.get('curveHistoryAccount')
			.data as CurveHistoryAccount;
	}

	public getLiquidationHistoryAccount(): LiquidationHistoryAccount {
		this.assertIsSubscribed();
		this.assertOptionalIsSubscribed('liquidationHistoryAccount');
		return this.subscribers.get('liquidationHistoryAccount')
			.data as LiquidationHistoryAccount;
	}
}
