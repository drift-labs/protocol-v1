import {
	NotSubscribedError,
	PollingUserAccountSubscriber,
	UserAccountEvents,
} from './types';
import { Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { getUserAccountPublicKey } from '../addresses';
import { UserAccount, UserPositionsAccount } from '../types';
import {
	OptionalSubscribableUserAccount,
	SubscribableUserAccountTypes,
} from '..';
import { PollingWebSocketAccountSubscriber } from './pollingWebSocketAccountSubscriber';

export class DefaultUserAccountSubscriber
	implements PollingUserAccountSubscriber
{
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	authority: PublicKey;

	subscribers: Map<
		SubscribableUserAccountTypes,
		PollingWebSocketAccountSubscriber<OptionalSubscribableUserAccount, SubscribableUserAccountTypes>
	> = new Map<
		SubscribableUserAccountTypes,
		PollingWebSocketAccountSubscriber<OptionalSubscribableUserAccount, SubscribableUserAccountTypes>
	>();

	public constructor(program: Program, authority: PublicKey) {
		this.isSubscribed = false;
		this.program = program;
		this.authority = authority;
		this.eventEmitter = new EventEmitter();
	}

	startPolling(account: SubscribableUserAccountTypes): boolean {

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

	stopPolling(account: SubscribableUserAccountTypes): boolean {
		return this.subscribers.get(account).stopPolling();

	}

	setPollingRate(
		account: SubscribableUserAccountTypes,
		rate: number
	): void {
		this.subscribers.get(account).setPollingRate(rate);
	}

	async subscribe(): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		const userPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.authority
		);
		this.subscribers.set(
			'userAccount',
			new PollingWebSocketAccountSubscriber(
				'userAccount',
				'user', 
				this.program, 
				userPublicKey
			)
		);
		await this.subscribers.get('userAccount').subscribe((data: UserAccount) => {
			this.eventEmitter.emit('userAccountUpdate', data);
			this.eventEmitter.emit('update');
		});

		const userAccountData = this.subscribers.get('userAccount')
			.data as UserAccount;

		this.subscribers.set(
			'userPositionsAccount',
			new PollingWebSocketAccountSubscriber(
				'userPositionsAccount',
				'userPositions',
				this.program,
				userAccountData.positions
			)
		);

		await this.subscribers
			.get('userPositionsAccount')
			.subscribe((data: UserPositionsAccount) => {
				this.eventEmitter.emit('userPositionsAccountUpdate', data);
				this.eventEmitter.emit('update');
			});

		this.eventEmitter.emit('update');
		this.isSubscribed = true;
		return true;
	}

	async fetch(): Promise<void> {
		await Promise.all(
			[...this.subscribers.values()]
				.filter((accountSubscriber) => accountSubscriber.isSubscribed)
				.map((accountSubscriber) => {
					return accountSubscriber.fetch();
				})
		);
		this.eventEmitter.emit('fetched');
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await Promise.all(
			[...this.subscribers.values()]
				.filter((accountSubscriber) => {
					return accountSubscriber.isSubscribed;
				})
				.map((accountSubscriber) => {
					return accountSubscriber.unsubscribe();
				})
		);

		this.isSubscribed = false;
	}

	assertIsSubscribed(account: SubscribableUserAccountTypes): void {
		if (!this.isSubscribed) {
			throw new NotSubscribedError(
				'You must call `subscribe` before using this function'
			);
		} else if (!this.subscribers.get(account).isSubscribed) {
			throw new NotSubscribedError(
				'Account ' + account.toString() + ' is not subscribed'
			);
		}
	}

	public getUserAccount(): UserAccount {
		this.assertIsSubscribed('userAccount');
		return this.subscribers.get('userAccount').data as UserAccount;
	}

	public getUserPositionsAccount(): UserPositionsAccount {
		this.assertIsSubscribed('userPositionsAccount');
		return this.subscribers.get('userPositionsAccount')
			.data as UserPositionsAccount;
	}
}
