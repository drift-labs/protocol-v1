import {
	AccountSubscriber,
	NotSubscribedError,
	PollingUserAccountSubscriber,
	UserAccountEvents
} from './types';
import { Program } from '@project-serum/anchor';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { getUserAccountPublicKey } from '../addresses';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';
import { UserAccount, UserPositionsAccount } from '../types';
import { OptionalSubscribableUserAccount, SubscribableUserAccountTypes } from '..';

export class DefaultUserAccountSubscriber implements PollingUserAccountSubscriber {
	isSubscribed: boolean;
	program: Program;
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	authority: PublicKey;

	pollRate: Map<SubscribableUserAccountTypes, number> = new Map<SubscribableUserAccountTypes, number>();
	pollInterval: Map<SubscribableUserAccountTypes, NodeJS.Timer> = new Map<SubscribableUserAccountTypes, NodeJS.Timer>();
	subscribers: Map<SubscribableUserAccountTypes, AccountSubscriber<OptionalSubscribableUserAccount>> = new Map<SubscribableUserAccountTypes, AccountSubscriber<OptionalSubscribableUserAccount>>();

	public constructor(program: Program, authority: PublicKey) {
		this.isSubscribed = false;
		this.program = program;
		this.authority = authority;
		this.eventEmitter = new EventEmitter();
	}

	startPolling(account: SubscribableUserAccountTypes): boolean {
		if (this.pollInterval.has(account)) {	
			throw new Error('already polling ' + account);
		}
		if (!this.pollRate.has(account)) {
			throw new Error('no poll rate set for ' + account);
		}
		if (!this.subscribers.has(account)) {
			throw new Error('could not find subscriber ' + account);
		}
		if (!this.subscribers.get(account).isSubscribed) {
			throw new Error('account is not subscribed ' + account);
		}
		this.pollInterval.set(account, setInterval(() => {
			this.subscribers.get(account).fetch().then(() => {
				this.eventEmitter.emit('fetchedAccount', account);
			});
		}, this.pollRate.get(account)));
		return true;
		
	}

	stopPolling(account: SubscribableUserAccountTypes): boolean {
		if (this.pollInterval.has(account)) {
			clearInterval(this.pollInterval.get(account));
			this.pollInterval.delete(account);
			return true;
		}
		return false;
		
	}

	setPollingRate(account: SubscribableUserAccountTypes, rate: number): void {
		this.pollRate.set(account, rate);
	}

	async subscribe(): Promise<boolean> {
		if (this.isSubscribed) {
			return true;
		}

		const userPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.authority
		);
		this.subscribers.set('userAccount', new WebSocketAccountSubscriber(
			'user',
			this.program,
			userPublicKey
		));
		await this.subscribers.get('userAccount').subscribe((data: UserAccount) => {
			this.eventEmitter.emit('userAccountData', data);
			this.eventEmitter.emit('update');
		});

		const userAccountData = this.subscribers.get('userAccount').data as UserAccount;

		this.subscribers.set('userPositionsAccount', new WebSocketAccountSubscriber(
			'userPositions',
			this.program,
			userAccountData.positions
		));

		await this.subscribers.get('userPositionsAccount').subscribe(
			(data: UserPositionsAccount) => {
				this.eventEmitter.emit('userPositionsData', data);
				this.eventEmitter.emit('update');
			}
		);

		this.eventEmitter.emit('update');
		this.isSubscribed = true;
		return true;
	}

	async fetch(): Promise<void> {
		await Promise.all([...this.subscribers.values()].filter(accountSubscriber => accountSubscriber.isSubscribed).map(accountSubscriber => {
			return accountSubscriber.fetch();
		}));
		this.eventEmitter.emit('fetched');
	}

	async unsubscribe(): Promise<void> {
		if (!this.isSubscribed) {
			return;
		}

		await Promise.all([...this.subscribers.values()].filter(accountSubscriber => {
			return accountSubscriber.isSubscribed;
		}).map(accountSubscriber => {
			return accountSubscriber.unsubscribe();
		}));

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
		return this.subscribers.get('userPositionsAccount').data as UserPositionsAccount;
	}
}
