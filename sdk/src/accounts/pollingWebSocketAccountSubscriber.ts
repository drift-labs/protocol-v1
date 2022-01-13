
import { Program } from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';
import { WebSocketAccountSubscriber } from './webSocketAccountSubscriber';

export class PollingWebSocketAccountSubscriber<T> extends WebSocketAccountSubscriber<T> {
	isSubscribed: boolean;
	data?: T;
	accountName: string;
	program: Program;
	accountPublicKey: PublicKey;
    pollInterval: NodeJS.Timer;
    pollRate: number;
	onChange: (data: T) => void;
    onFetch: (accountType: string) => void;

	public constructor(
		accountName: string,
		program: Program,
		accountPublicKey: PublicKey
	) {
		super(accountName, program, accountPublicKey);
	}

	async subscribe(onChange: (data: T) => void): Promise<void> {
		this.onChange = onChange;
		await this.fetch();
		this.isSubscribed = true;
		this.program.account[this.accountName]
			.subscribe(this.accountPublicKey, this.program.provider.opts.commitment)
			.on('change', async (data: T) => {
				this.data = data;
				this.onChange(data);
			});
	}

	async fetch(): Promise<void> {
		const newData = (await this.program.account[this.accountName].fetch(
			this.accountPublicKey
		)) as T;

		// if data has changed trigger update
		if (JSON.stringify(newData) !== JSON.stringify(this.data)) {
			this.data = newData;
			this.onChange(this.data);
		}
	}


    startPolling(onFetch: (account: string) => void): boolean {
        if (this.pollInterval != null) {
            throw new Error('already polling ' + this.accountName);
        }
        this.onFetch = onFetch;
		this.pollInterval = setInterval(() => {
            this.fetch().then(() => {
                this.onFetch(this.accountName);
            });
        }, this.pollRate);
		return true;
	}

	stopPolling(): boolean {
		if (this.pollInterval != null) {
			clearInterval(this.pollInterval);
			return true;
		}
		return false;
	}

	setPollingRate(rate: number): void {
		this.pollRate = rate;
	}




	unsubscribe(): Promise<void> {
		const unsubscribed = this.program.account[this.accountName].unsubscribe(
			this.accountPublicKey
		);
		this.isSubscribed = false;
		return unsubscribed;
	}
}
