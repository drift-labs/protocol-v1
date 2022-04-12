import { BN, Idl, Program, Provider } from '@project-serum/anchor';
import {
	ASSOCIATED_TOKEN_PROGRAM_ID,
	Token,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
	MarketsAccount,
	StateAccount,
	DepositHistoryAccount,
	FundingPaymentHistoryAccount,
	FundingRateHistoryAccount,
	IWallet,
	LiquidationHistoryAccount,
	PositionDirection,
	TradeHistoryAccount,
	UserAccount,
	Market,
	OrderHistoryAccount,
	OrderStateAccount,
	OrderParams,
	Order,
	ExtendedCurveHistoryAccount,
	UserRegistryAccount,
} from './types';
import * as anchor from '@project-serum/anchor';
import clearingHouseIDL from './idl/clearing_house.json';

import {
	Connection,
	PublicKey,
	TransactionSignature,
	Keypair,
	ConfirmOptions,
	Transaction,
	TransactionInstruction,
} from '@solana/web3.js';

import { MockUSDCFaucet } from './mockUSDCFaucet';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import {
	getClearingHouseStateAccountPublicKey,
	getOrderStateAccountPublicKey,
	getUserAccountPublicKey,
	getUserAccountPublicKeyAndNonce,
	getUserOrdersAccountPublicKey,
	getUserOrdersAccountPublicKeyAndNonce,
	getUserRegistryAccountPublicKey,
	getUserRegistryPublicKeyAndNonce,
} from './addresses';
import {
	ClearingHouseAccountSubscriber,
	ClearingHouseAccountEvents,
	ClearingHouseAccountTypes,
} from './accounts/types';
import { TxSender } from './tx/types';
import { wrapInTx } from './tx/utils';
import {
	getClearingHouse,
	getWebSocketClearingHouseConfig,
} from './factory/clearingHouse';
import { ZERO } from './constants/numericConstants';
import { UserRegistry } from './userRegistry/userRegistry';

/**
 * # ClearingHouse
 * This class is the main way to interact with Drift Protocol. It allows you to subscribe to the various accounts where the Market's state is stored, as well as: opening positions, liquidating, settling funding, depositing & withdrawing, and more.
 *
 * The default way to construct a ClearingHouse instance is using the {@link from} method. This will create an instance using the static {@link WebSocketClearingHouseAccountSubscriber}, which will use a websocket for each state account subscription.
 * Alternatively, if you want to implement your own method of subscribing to the state accounts on the blockchain, you can implement a {@link ClearingHouseAccountSubscriber} and use it in the {@link ClearingHouse.constructor}
 */
export class ClearingHouse {
	connection: Connection;
	wallet: IWallet;
	public program: Program;
	provider: Provider;
	opts?: ConfirmOptions;
	accountSubscriber: ClearingHouseAccountSubscriber;
	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseAccountEvents>;
	_isSubscribed = false;
	txSender: TxSender;
	seed: number;

	public get isSubscribed() {
		return this._isSubscribed && this.accountSubscriber.isSubscribed;
	}

	public set isSubscribed(val: boolean) {
		this._isSubscribed = val;
	}

	/**
	 * @deprecated You should use the getClearingHouse factory method instead
	 * @param connection
	 * @param wallet
	 * @param clearingHouseProgramId
	 * @param opts
	 * @param seed
	 * @returns
	 */
	public static from(
		connection: Connection,
		wallet: IWallet,
		clearingHouseProgramId: PublicKey,
		opts: ConfirmOptions = Provider.defaultOptions(),
		seed?: number
	): ClearingHouse {
		const config = getWebSocketClearingHouseConfig(
			connection,
			wallet,
			clearingHouseProgramId,
			opts,
			undefined,
			seed
		);
		return getClearingHouse(config);
	}

	public constructor(
		connection: Connection,
		wallet: IWallet,
		program: Program,
		accountSubscriber: ClearingHouseAccountSubscriber,
		txSender: TxSender,
		opts: ConfirmOptions,
		seed = 0
	) {
		this.connection = connection;
		this.wallet = wallet;
		this.opts = opts;
		this.program = program;
		this.accountSubscriber = accountSubscriber;
		this.eventEmitter = this.accountSubscriber.eventEmitter;
		this.txSender = txSender;
		this.seed = seed;
	}

	/**
	 *
	 * @param optionalSubscriptions - Optional extra accounts to subcribe to. Always subscribes to base clearing house state and market account state by default. You should only subscribe to optional extra accounts if required, to avoid overloading your RPC.
	 * @returns Promise<boolean> : SubscriptionSuccess
	 */
	public async subscribe(
		optionalSubscriptions?: ClearingHouseAccountTypes[]
	): Promise<boolean> {
		this.isSubscribed = await this.accountSubscriber.subscribe(
			optionalSubscriptions
		);
		return this.isSubscribed;
	}

	/**
	 * Shorthand function to subscribe to all available Clearing House State Accounts
	 * @returns Promise<boolean> : SubscriptionSuccess
	 */
	public async subscribeToAll(): Promise<boolean> {
		return this.subscribe([
			'curveHistoryAccount',
			'depositHistoryAccount',
			'fundingPaymentHistoryAccount',
			'fundingRateHistoryAccount',
			'liquidationHistoryAccount',
			'tradeHistoryAccount',
			'orderHistoryAccount',
		]);
	}

	/**
	 *	Forces the accountSubscriber to fetch account updates from rpc
	 */
	public async fetchAccounts(): Promise<void> {
		await this.accountSubscriber.fetch();
	}

	/**
	 * Unsubscribe from all currently subscribed state accounts
	 */
	public async unsubscribe(): Promise<void> {
		await this.accountSubscriber.unsubscribe();
		this.isSubscribed = false;
	}

	statePublicKey?: PublicKey;
	public async getStatePublicKey(): Promise<PublicKey> {
		if (this.statePublicKey) {
			return this.statePublicKey;
		}
		this.statePublicKey = await getClearingHouseStateAccountPublicKey(
			this.program.programId
		);
		return this.statePublicKey;
	}

	public getStateAccount(): StateAccount {
		return this.accountSubscriber.getStateAccount();
	}

	public getMarketsAccount(): MarketsAccount {
		return this.accountSubscriber.getMarketsAccount();
	}

	public getMarket(marketIndex: BN | number): Market {
		if (marketIndex instanceof BN) {
			marketIndex = marketIndex.toNumber();
		}
		return this.getMarketsAccount().markets[marketIndex];
	}

	public getFundingPaymentHistoryAccount(): FundingPaymentHistoryAccount {
		return this.accountSubscriber.getFundingPaymentHistoryAccount();
	}

	public getFundingRateHistoryAccount(): FundingRateHistoryAccount {
		return this.accountSubscriber.getFundingRateHistoryAccount();
	}

	public getTradeHistoryAccount(): TradeHistoryAccount {
		return this.accountSubscriber.getTradeHistoryAccount();
	}

	public getLiquidationHistoryAccount(): LiquidationHistoryAccount {
		return this.accountSubscriber.getLiquidationHistoryAccount();
	}

	public getDepositHistoryAccount(): DepositHistoryAccount {
		return this.accountSubscriber.getDepositHistoryAccount();
	}

	public getCurveHistoryAccount(): ExtendedCurveHistoryAccount {
		return this.accountSubscriber.getCurveHistoryAccount();
	}

	public getOrderHistoryAccount(): OrderHistoryAccount {
		return this.accountSubscriber.getOrderHistoryAccount();
	}

	orderStatePublicKey?: PublicKey;
	public async getOrderStatePublicKey(): Promise<PublicKey> {
		if (this.orderStatePublicKey) {
			return this.orderStatePublicKey;
		}
		this.orderStatePublicKey = await getOrderStateAccountPublicKey(
			this.program.programId
		);
		return this.orderStatePublicKey;
	}

	public getOrderStateAccount(): OrderStateAccount {
		return this.accountSubscriber.getOrderStateAccount();
	}

	/**
	 * Update the wallet to use for clearing house transactions and linked user account
	 * @param newWallet
	 */
	public updateWallet(newWallet: IWallet): void {
		const newProvider = new Provider(this.connection, newWallet, this.opts);
		const newProgram = new Program(
			clearingHouseIDL as Idl,
			this.program.programId,
			newProvider
		);

		// Update provider for txSender with new wallet details
		this.txSender.provider = newProvider;

		this.wallet = newWallet;
		this.provider = newProvider;
		this.program = newProgram;

		// reset cached values
		this.userAccountPublicKeyMap = new Map<number, PublicKey>();
		this.userAccountMap = new Map<number, UserAccount>();
		this.userOrdersAccountPublicKeyMap = new Map<number, PublicKey>();
		this.userOrdersExistMap = new Map<number, boolean>();
		this.userRegistryAccountPublicKey = undefined;
		this.userRegistryAccount = undefined;
	}

	public updateSeed(seed: number): void {
		this.seed = seed;
	}

	public async initializeUserAccount(): Promise<
		[TransactionSignature, PublicKey]
	> {
		const [
			userPositionsAccount,
			userAccountPublicKey,
			initializeUserAccountIx,
			initializeUserOrdersAccountIx,
		] = await this.getInitializeUserInstructions();

		const tx = new Transaction()
			.add(initializeUserAccountIx)
			.add(initializeUserOrdersAccountIx);
		const txSig = await this.txSender.send(
			tx,
			[userPositionsAccount],
			this.opts
		);
		return [txSig, userAccountPublicKey];
	}

	async getInitializeUserInstructions(): Promise<
		[Keypair, PublicKey, TransactionInstruction, TransactionInstruction]
	> {
		const [userAccountPublicKey, userAccountNonce] =
			await getUserAccountPublicKeyAndNonce(
				this.program.programId,
				this.wallet.publicKey
			);

		const remainingAccounts = [];
		const optionalAccounts = {
			whitelistToken: false,
		};

		const state = this.getStateAccount();
		if (state.whitelistMint) {
			optionalAccounts.whitelistToken = true;
			const associatedTokenPublicKey = await Token.getAssociatedTokenAddress(
				ASSOCIATED_TOKEN_PROGRAM_ID,
				TOKEN_PROGRAM_ID,
				state.whitelistMint,
				this.wallet.publicKey
			);
			remainingAccounts.push({
				pubkey: associatedTokenPublicKey,
				isWritable: false,
				isSigner: false,
			});
		}

		const userPositions = new Keypair();
		const initializeUserAccountIx =
			await this.program.instruction.initializeUser(
				userAccountNonce,
				optionalAccounts,
				{
					accounts: {
						user: userAccountPublicKey,
						authority: this.wallet.publicKey,
						rent: anchor.web3.SYSVAR_RENT_PUBKEY,
						systemProgram: anchor.web3.SystemProgram.programId,
						userPositions: userPositions.publicKey,
						state: await this.getStatePublicKey(),
					},
					remainingAccounts: remainingAccounts,
				}
			);

		const initializeUserOrdersAccountIx =
			await this.getInitializeUserOrdersInstruction(userAccountPublicKey);

		return [
			userPositions,
			userAccountPublicKey,
			initializeUserAccountIx,
			initializeUserOrdersAccountIx,
		];
	}

	async getInitializeUserOrdersInstruction(
		userAccountPublicKey?: PublicKey
	): Promise<TransactionInstruction> {
		if (!userAccountPublicKey) {
			userAccountPublicKey = await this.getUserAccountPublicKey();
		}

		const [userOrdersAccountPublicKey, userOrdersAccountNonce] =
			await getUserOrdersAccountPublicKeyAndNonce(
				this.program.programId,
				userAccountPublicKey
			);

		return await this.program.instruction.initializeUserOrders(
			userOrdersAccountNonce,
			{
				accounts: {
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
					rent: anchor.web3.SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					userOrders: userOrdersAccountPublicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async initializeUserRegistryAccount(
		firstUserName: number[]
	): Promise<TransactionSignature> {
		return this.txSender.send(
			wrapInTx(await this.initializeUserRegistryAccountIx(firstUserName)),
			[],
			this.opts
		);
	}

	public async initializeUserRegistryAccountIx(
		firstUserName: number[]
	): Promise<TransactionInstruction> {
		const [userRegistryAccountPublicKey, userRegistryAccountNonce] =
			await getUserRegistryPublicKeyAndNonce(
				this.program.programId,
				this.wallet.publicKey
			);

		return await this.program.instruction.initializeUserRegistry(
			userRegistryAccountNonce,
			firstUserName,
			{
				accounts: {
					userRegistry: userRegistryAccountPublicKey,
					user: await this.getUserAccountPublicKey(),
					authority: this.wallet.publicKey,
					rent: anchor.web3.SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
				},
			}
		);
	}

	public async addUser(
		seed: number,
		name: number[]
	): Promise<TransactionSignature> {
		const [addUserIx, userAccountPublicKey, userPositionsKeyPair] =
			await this.addUserIx(seed, name);
		const initializeUserOrderIx = await this.getInitializeUserOrdersInstruction(
			userAccountPublicKey
		);
		const tx = new Transaction().add(addUserIx).add(initializeUserOrderIx);

		return this.txSender.send(tx, [userPositionsKeyPair], this.opts);
	}

	public async addUserIx(
		seed: number,
		name: number[]
	): Promise<[TransactionInstruction, PublicKey, Keypair]> {
		const [userAccountPublicKey, userAccountNonce] =
			await getUserAccountPublicKeyAndNonce(
				this.program.programId,
				this.wallet.publicKey,
				seed
			);

		const userPositions = new Keypair();
		const ix = await this.program.instruction.addUser(
			seed,
			userAccountNonce,
			name,
			{
				accounts: {
					userRegistry: await this.getUserRegistryAccountPublicKey(),
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
					rent: anchor.web3.SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					userPositions: userPositions.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
		return [ix, userAccountPublicKey, userPositions];
	}

	public async updateUserName(
		seed: number,
		name: number[]
	): Promise<TransactionSignature> {
		return this.txSender.send(
			wrapInTx(await this.updateUserNameIx(seed, name)),
			[],
			this.opts
		);
	}

	public async updateUserNameIx(
		seed: number,
		name: number[]
	): Promise<TransactionInstruction> {
		return await this.program.instruction.updateUserName(seed, name, {
			accounts: {
				userRegistry: await this.getUserRegistryAccountPublicKey(),
				authority: this.wallet.publicKey,
			},
		});
	}

	userAccountPublicKeyMap = new Map<number, PublicKey>();
	/**
	 * Get the address for the Clearing House User's account. NOT the user's wallet address.
	 * @returns
	 */
	public async getUserAccountPublicKey(): Promise<PublicKey> {
		if (this.userAccountPublicKeyMap.has(this.seed)) {
			return this.userAccountPublicKeyMap.get(this.seed);
		}

		const userAccountPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			this.seed
		);
		this.userAccountPublicKeyMap.set(this.seed, userAccountPublicKey);
		return userAccountPublicKey;
	}

	userAccountMap = new Map<number, UserAccount>();
	public async getUserAccount(): Promise<UserAccount> {
		if (this.userAccountMap.has(this.seed)) {
			return this.userAccountMap.get(this.seed);
		}

		const userAccount = (await this.program.account.user.fetch(
			await this.getUserAccountPublicKey()
		)) as UserAccount;
		this.userAccountMap.set(this.seed, userAccount);
		return userAccount;
	}

	userOrdersAccountPublicKeyMap = new Map<number, PublicKey>();
	/**
	 * Get the address for the Clearing House User Order's account. NOT the user's wallet address.
	 * @returns
	 */
	public async getUserOrdersAccountPublicKey(): Promise<PublicKey> {
		if (this.userOrdersAccountPublicKeyMap.has(this.seed)) {
			return this.userOrdersAccountPublicKeyMap.get(this.seed);
		}

		const userOrdersAccountPublicKey = await getUserOrdersAccountPublicKey(
			this.program.programId,
			await this.getUserAccountPublicKey()
		);
		this.userOrdersAccountPublicKeyMap.set(
			this.seed,
			userOrdersAccountPublicKey
		);
		return userOrdersAccountPublicKey;
	}

	userOrdersExistMap = new Map<number, boolean>();
	async userOrdersAccountExists(): Promise<boolean> {
		if (this.userOrdersExistMap.has(this.seed)) {
			return this.userOrdersExistMap.get(this.seed);
		}
		const userOrdersAccountRPCResponse =
			await this.connection.getParsedAccountInfo(
				await this.getUserOrdersAccountPublicKey()
			);

		const userOrdersExist = userOrdersAccountRPCResponse.value !== null;
		this.userOrdersExistMap.set(this.seed, userOrdersExist);
		return userOrdersExist;
	}

	userRegistryAccountPublicKey?: PublicKey;
	/**
	 * Get the address for the Clearing House User Registry account.
	 * @returns
	 */
	public async getUserRegistryAccountPublicKey(): Promise<PublicKey> {
		if (this.userRegistryAccountPublicKey) {
			return this.userRegistryAccountPublicKey;
		}

		this.userRegistryAccountPublicKey = await getUserRegistryAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey
		);
		return this.userRegistryAccountPublicKey;
	}

	userRegistryAccount?: UserRegistryAccount;
	public async getUserRegistryAccount(): Promise<UserRegistryAccount> {
		if (this.userRegistryAccount) {
			return this.userRegistryAccount;
		}

		this.userRegistryAccount = (await this.program.account.userRegistry.fetch(
			await this.getUserRegistryAccountPublicKey()
		)) as UserRegistryAccount;
		return this.userRegistryAccount;
	}

	public async getUserRegistry(): Promise<UserRegistry> {
		return new UserRegistry(await this.getUserRegistryAccount());
	}

	public async depositCollateral(
		amount: BN,
		collateralAccountPublicKey: PublicKey,
		userPositionsAccountPublicKey?: PublicKey
	): Promise<TransactionSignature> {
		const depositCollateralIx = await this.getDepositCollateralInstruction(
			amount,
			collateralAccountPublicKey,
			userPositionsAccountPublicKey
		);

		const tx = new Transaction().add(depositCollateralIx);

		return await this.txSender.send(tx);
	}

	async getDepositCollateralInstruction(
		amount: BN,
		collateralAccountPublicKey: PublicKey,
		userPositionsAccountPublicKey?: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		if (!userPositionsAccountPublicKey) {
			userPositionsAccountPublicKey = (await this.getUserAccount()).positions;
		}

		const state = this.getStateAccount();
		return await this.program.instruction.depositCollateral(amount, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				collateralVault: state.collateralVault,
				userCollateralAccount: collateralAccountPublicKey,
				authority: this.wallet.publicKey,
				tokenProgram: TOKEN_PROGRAM_ID,
				markets: state.markets,
				fundingPaymentHistory: state.fundingPaymentHistory,
				depositHistory: state.depositHistory,
				userPositions: userPositionsAccountPublicKey,
			},
		});
	}

	/**
	 * Creates the Clearing House User account for a user, and deposits some initial collateral
	 * @param amount
	 * @param collateralAccountPublicKey
	 * @returns
	 */
	public async initializeUserAccountAndDepositCollateral(
		amount: BN,
		collateralAccountPublicKey: PublicKey
	): Promise<[TransactionSignature, PublicKey]> {
		const [
			userPositionsAccount,
			userAccountPublicKey,
			initializeUserAccountIx,
			initializeUserOrdersAccountIx,
		] = await this.getInitializeUserInstructions();

		const depositCollateralIx = await this.getDepositCollateralInstruction(
			amount,
			collateralAccountPublicKey,
			userPositionsAccount.publicKey
		);

		const tx = new Transaction()
			.add(initializeUserAccountIx)
			.add(initializeUserOrdersAccountIx)
			.add(depositCollateralIx);

		const txSig = await this.program.provider.send(tx, [userPositionsAccount]);

		return [txSig, userAccountPublicKey];
	}

	public async initializeUserAccountForDevnet(
		mockUSDCFaucet: MockUSDCFaucet,
		amount: BN
	): Promise<[TransactionSignature, PublicKey]> {
		const [associateTokenPublicKey, createAssociatedAccountIx, mintToIx] =
			await mockUSDCFaucet.createAssociatedTokenAccountAndMintToInstructions(
				this.wallet.publicKey,
				amount
			);

		const [
			userPositionsAccount,
			userAccountPublicKey,
			initializeUserAccountIx,
			initializeUserOrdersAccountIx,
		] = await this.getInitializeUserInstructions();

		const depositCollateralIx = await this.getDepositCollateralInstruction(
			amount,
			associateTokenPublicKey,
			userPositionsAccount.publicKey
		);

		const tx = new Transaction()
			.add(createAssociatedAccountIx)
			.add(mintToIx)
			.add(initializeUserAccountIx)
			.add(initializeUserOrdersAccountIx)
			.add(depositCollateralIx);

		const txSig = await this.program.provider.send(tx, [userPositionsAccount]);

		return [txSig, userAccountPublicKey];
	}

	public async deleteUser(): Promise<TransactionSignature> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const user = await this.program.account.user.fetch(userAccountPublicKey);
		const deleteUserTx = await this.program.transaction.deleteUser({
			accounts: {
				user: userAccountPublicKey,
				userPositions: user.positions,
				authority: this.wallet.publicKey,
			},
		});
		return this.txSender.send(deleteUserTx, [], this.opts);
	}

	public async withdrawCollateral(
		amount: BN,
		collateralAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		return this.txSender.send(
			wrapInTx(
				await this.getWithdrawCollateralIx(amount, collateralAccountPublicKey)
			),
			[],
			this.opts
		);
	}

	public async getWithdrawCollateralIx(
		amount: BN,
		collateralAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const user: any = await this.program.account.user.fetch(
			userAccountPublicKey
		);

		const state = this.getStateAccount();
		return await this.program.instruction.withdrawCollateral(amount, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				collateralVault: state.collateralVault,
				collateralVaultAuthority: state.collateralVaultAuthority,
				insuranceVault: state.insuranceVault,
				insuranceVaultAuthority: state.insuranceVaultAuthority,
				userCollateralAccount: collateralAccountPublicKey,
				authority: this.wallet.publicKey,
				tokenProgram: TOKEN_PROGRAM_ID,
				markets: state.markets,
				userPositions: user.positions,
				fundingPaymentHistory: state.fundingPaymentHistory,
				depositHistory: state.depositHistory,
			},
		});
	}

	public async transferCollateral(
		amount: BN,
		userPublicKey: PublicKey
	): Promise<TransactionSignature> {
		return this.txSender.send(
			wrapInTx(await this.getTransferCollateralIx(amount, userPublicKey)),
			[],
			this.opts
		);
	}

	public async getTransferCollateralIx(
		amount: BN,
		userPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const fromUserAccountPublicKey = await this.getUserAccountPublicKey();
		const fromUser = (await this.program.account.user.fetch(
			fromUserAccountPublicKey
		)) as UserAccount;
		const toUser = (await this.program.account.user.fetch(
			userPublicKey
		)) as UserAccount;

		const state = this.getStateAccount();
		return await this.program.instruction.transferCollateral(amount, {
			accounts: {
				state: await this.getStatePublicKey(),
				fromUser: fromUserAccountPublicKey,
				fromUserPositions: fromUser.positions,
				toUser: userPublicKey,
				toUserPositions: toUser.positions,
				authority: this.wallet.publicKey,
				markets: state.markets,
				fundingPaymentHistory: state.fundingPaymentHistory,
				depositHistory: state.depositHistory,
			},
		});
	}

	public async openPosition(
		direction: PositionDirection,
		amount: BN,
		marketIndex: BN,
		limitPrice?: BN,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		return await this.txSender.send(
			wrapInTx(
				await this.getOpenPositionIx(
					direction,
					amount,
					marketIndex,
					limitPrice,
					discountToken,
					referrer
				)
			),
			[],
			this.opts
		);
	}

	public async getOpenPositionIx(
		direction: PositionDirection,
		amount: BN,
		marketIndex: BN,
		limitPrice?: BN,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const userAccount = await this.getUserAccount();

		if (limitPrice == undefined) {
			limitPrice = new BN(0); // no limit
		}

		const optionalAccounts = {
			discountToken: false,
			referrer: false,
		};
		const remainingAccounts = [];
		if (discountToken) {
			optionalAccounts.discountToken = true;
			remainingAccounts.push({
				pubkey: discountToken,
				isWritable: false,
				isSigner: false,
			});
		}
		if (referrer) {
			optionalAccounts.referrer = true;
			remainingAccounts.push({
				pubkey: referrer,
				isWritable: true,
				isSigner: false,
			});
		}

		const priceOracle =
			this.getMarketsAccount().markets[marketIndex.toNumber()].amm.oracle;

		const state = this.getStateAccount();
		return await this.program.instruction.openPosition(
			direction,
			amount,
			marketIndex,
			limitPrice,
			optionalAccounts,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
					markets: state.markets,
					userPositions: userAccount.positions,
					tradeHistory: state.tradeHistory,
					fundingPaymentHistory: state.fundingPaymentHistory,
					fundingRateHistory: state.fundingRateHistory,
					oracle: priceOracle,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async initializeUserOrdersThenPlaceOrder(
		orderParams: OrderParams,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		const instructions: anchor.web3.TransactionInstruction[] = [];
		const userOrdersAccountExists = await this.userOrdersAccountExists();
		if (!userOrdersAccountExists) {
			instructions.push(await this.getInitializeUserOrdersInstruction());
		}
		instructions.push(
			await this.getPlaceOrderIx(orderParams, discountToken, referrer)
		);
		const tx = new Transaction();
		for (const instruction of instructions) {
			tx.add(instruction);
		}

		return await this.txSender.send(tx, [], this.opts);
	}

	public async placeOrder(
		orderParams: OrderParams,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		return await this.txSender.send(
			wrapInTx(
				await this.getPlaceOrderIx(orderParams, discountToken, referrer)
			),
			[],
			this.opts
		);
	}

	public async getPlaceOrderIx(
		orderParams: OrderParams,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const userAccount = await this.getUserAccount();

		const priceOracle =
			this.getMarketsAccount().markets[orderParams.marketIndex.toNumber()].amm
				.oracle;

		const remainingAccounts = [];
		if (orderParams.optionalAccounts.discountToken) {
			if (!discountToken) {
				throw Error(
					'Optional accounts specified discount token but no discount token present'
				);
			}

			remainingAccounts.push({
				pubkey: discountToken,
				isWritable: false,
				isSigner: false,
			});
		}

		if (orderParams.optionalAccounts.referrer) {
			if (!referrer) {
				throw Error(
					'Optional accounts specified referrer but no referrer present'
				);
			}

			remainingAccounts.push({
				pubkey: referrer,
				isWritable: false,
				isSigner: false,
			});
		}

		if (!orderParams.oraclePriceOffset.eq(ZERO)) {
			remainingAccounts.push({
				pubkey: priceOracle,
				isWritable: false,
				isSigner: false,
			});
		}

		const state = this.getStateAccount();
		const orderState = this.getOrderStateAccount();
		return await this.program.instruction.placeOrder(orderParams, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				markets: state.markets,
				userOrders: await this.getUserOrdersAccountPublicKey(),
				userPositions: userAccount.positions,
				fundingPaymentHistory: state.fundingPaymentHistory,
				fundingRateHistory: state.fundingRateHistory,
				orderState: await this.getOrderStatePublicKey(),
				orderHistory: orderState.orderHistory,
			},
			remainingAccounts,
		});
	}

	public async expireOrders(
		userAccountPublicKey: PublicKey,
		userOrdersAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		return await this.txSender.send(
			wrapInTx(
				await this.getExpireOrdersIx(
					userAccountPublicKey,
					userOrdersAccountPublicKey
				)
			),
			[],
			this.opts
		);
	}

	public async getExpireOrdersIx(
		userAccountPublicKey: PublicKey,
		userOrdersAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const fillerPublicKey = await this.getUserAccountPublicKey();
		const userAccount: any = await this.program.account.user.fetch(
			userAccountPublicKey
		);

		const orderState = this.getOrderStateAccount();
		return await this.program.instruction.expireOrders({
			accounts: {
				state: await this.getStatePublicKey(),
				filler: fillerPublicKey,
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				userPositions: userAccount.positions,
				userOrders: userOrdersAccountPublicKey,
				orderState: await this.getOrderStatePublicKey(),
				orderHistory: orderState.orderHistory,
			},
		});
	}

	public async cancelOrder(
		orderId: BN,
		oracle?: PublicKey
	): Promise<TransactionSignature> {
		return await this.txSender.send(
			wrapInTx(await this.getCancelOrderIx(orderId, oracle)),
			[],
			this.opts
		);
	}

	public async getCancelOrderIx(
		orderId: BN,
		oracle?: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const userAccount = await this.getUserAccount();

		const state = this.getStateAccount();
		const orderState = this.getOrderStateAccount();

		const remainingAccounts = [];
		if (oracle) {
			remainingAccounts.push({
				pubkey: oracle,
				isWritable: false,
				isSigner: false,
			});
		}

		return await this.program.instruction.cancelOrder(orderId, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				markets: state.markets,
				userOrders: await this.getUserOrdersAccountPublicKey(),
				userPositions: userAccount.positions,
				fundingPaymentHistory: state.fundingPaymentHistory,
				fundingRateHistory: state.fundingRateHistory,
				orderState: await this.getOrderStatePublicKey(),
				orderHistory: orderState.orderHistory,
			},
			remainingAccounts,
		});
	}

	public async cancelOrderByUserId(
		userOrderId: number,
		oracle?: PublicKey
	): Promise<TransactionSignature> {
		return await this.txSender.send(
			wrapInTx(await this.getCancelOrderByUserIdIx(userOrderId, oracle)),
			[],
			this.opts
		);
	}

	public async getCancelOrderByUserIdIx(
		userOrderId: number,
		oracle?: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const userAccount = await this.getUserAccount();

		const state = this.getStateAccount();
		const orderState = this.getOrderStateAccount();

		const remainingAccounts = [];
		if (oracle) {
			remainingAccounts.push({
				pubkey: oracle,
				isWritable: false,
				isSigner: false,
			});
		}

		return await this.program.instruction.cancelOrderByUserId(userOrderId, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				markets: state.markets,
				userOrders: await this.getUserOrdersAccountPublicKey(),
				userPositions: userAccount.positions,
				fundingPaymentHistory: state.fundingPaymentHistory,
				fundingRateHistory: state.fundingRateHistory,
				orderState: await this.getOrderStatePublicKey(),
				orderHistory: orderState.orderHistory,
			},
			remainingAccounts,
		});
	}

	public async fillOrder(
		userAccountPublicKey: PublicKey,
		userOrdersAccountPublicKey: PublicKey,
		order: Order
	): Promise<TransactionSignature> {
		return await this.txSender.send(
			wrapInTx(
				await this.getFillOrderIx(
					userAccountPublicKey,
					userOrdersAccountPublicKey,
					order
				)
			),
			[],
			this.opts
		);
	}

	public async getFillOrderIx(
		userAccountPublicKey: PublicKey,
		userOrdersAccountPublicKey: PublicKey,
		order: Order
	): Promise<TransactionInstruction> {
		const fillerPublicKey = await this.getUserAccountPublicKey();
		const userAccount: any = await this.program.account.user.fetch(
			userAccountPublicKey
		);

		const marketIndex = order.marketIndex;
		const oracle = this.getMarket(marketIndex).amm.oracle;

		const state = this.getStateAccount();
		const orderState = this.getOrderStateAccount();

		const remainingAccounts = [];
		if (!order.referrer.equals(PublicKey.default)) {
			remainingAccounts.push({
				pubkey: order.referrer,
				isWritable: true,
				isSigner: false,
			});
		}

		const orderId = order.orderId;
		return await this.program.instruction.fillOrder(orderId, {
			accounts: {
				state: await this.getStatePublicKey(),
				filler: fillerPublicKey,
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				markets: state.markets,
				userPositions: userAccount.positions,
				userOrders: userOrdersAccountPublicKey,
				tradeHistory: state.tradeHistory,
				fundingPaymentHistory: state.fundingPaymentHistory,
				fundingRateHistory: state.fundingRateHistory,
				orderState: await this.getOrderStatePublicKey(),
				orderHistory: orderState.orderHistory,
				extendedCurveHistory: state.extendedCurveHistory,
				oracle: oracle,
			},
			remainingAccounts,
		});
	}

	public async initializeUserOrdersThenPlaceAndFillOrder(
		orderParams: OrderParams,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		const instructions: anchor.web3.TransactionInstruction[] = [];
		const userOrdersAccountExists = await this.userOrdersAccountExists();
		if (!userOrdersAccountExists) {
			instructions.push(await this.getInitializeUserOrdersInstruction());
		}
		instructions.push(
			await this.getPlaceAndFillOrderIx(orderParams, discountToken, referrer)
		);
		const tx = new Transaction();
		for (const instruction of instructions) {
			tx.add(instruction);
		}

		return await this.txSender.send(tx, [], this.opts);
	}

	public async placeAndFillOrder(
		orderParams: OrderParams,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		return await this.txSender.send(
			wrapInTx(
				await this.getPlaceAndFillOrderIx(orderParams, discountToken, referrer)
			),
			[],
			this.opts
		);
	}

	public async getPlaceAndFillOrderIx(
		orderParams: OrderParams,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const userAccount = await this.getUserAccount();

		const priceOracle =
			this.getMarketsAccount().markets[orderParams.marketIndex.toNumber()].amm
				.oracle;

		const remainingAccounts = [];
		if (orderParams.optionalAccounts.discountToken) {
			if (!discountToken) {
				throw Error(
					'Optional accounts specified discount token but no discount token present'
				);
			}

			remainingAccounts.push({
				pubkey: discountToken,
				isWritable: false,
				isSigner: false,
			});
		}

		if (orderParams.optionalAccounts.referrer) {
			if (!referrer) {
				throw Error(
					'Optional accounts specified referrer but no referrer present'
				);
			}

			remainingAccounts.push({
				pubkey: referrer,
				isWritable: true,
				isSigner: false,
			});
		}

		const state = this.getStateAccount();
		const orderState = this.getOrderStateAccount();
		return await this.program.instruction.placeAndFillOrder(orderParams, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				markets: state.markets,
				userOrders: await this.getUserOrdersAccountPublicKey(),
				userPositions: userAccount.positions,
				tradeHistory: state.tradeHistory,
				fundingPaymentHistory: state.fundingPaymentHistory,
				fundingRateHistory: state.fundingRateHistory,
				orderState: await this.getOrderStatePublicKey(),
				orderHistory: orderState.orderHistory,
				extendedCurveHistory: state.extendedCurveHistory,
				oracle: priceOracle,
			},
			remainingAccounts,
		});
	}

	/**
	 * Close an entire position. If you want to reduce a position, use the {@link openPosition} method in the opposite direction of the current position.
	 * @param marketIndex
	 * @param discountToken
	 * @param referrer
	 * @returns
	 */
	public async closePosition(
		marketIndex: BN,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		return await this.txSender.send(
			wrapInTx(
				await this.getClosePositionIx(marketIndex, discountToken, referrer)
			),
			[],
			this.opts
		);
	}

	public async getClosePositionIx(
		marketIndex: BN,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const userAccount = await this.getUserAccount();

		const priceOracle =
			this.getMarketsAccount().markets[marketIndex.toNumber()].amm.oracle;

		const optionalAccounts = {
			discountToken: false,
			referrer: false,
		};
		const remainingAccounts = [];
		if (discountToken) {
			optionalAccounts.discountToken = true;
			remainingAccounts.push({
				pubkey: discountToken,
				isWritable: false,
				isSigner: false,
			});
		}
		if (referrer) {
			optionalAccounts.referrer = true;
			remainingAccounts.push({
				pubkey: referrer,
				isWritable: true,
				isSigner: false,
			});
		}

		const state = this.getStateAccount();
		return await this.program.instruction.closePosition(
			marketIndex,
			optionalAccounts,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
					markets: state.markets,
					userPositions: userAccount.positions,
					tradeHistory: state.tradeHistory,
					fundingPaymentHistory: state.fundingPaymentHistory,
					fundingRateHistory: state.fundingRateHistory,
					oracle: priceOracle,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async liquidate(
		liquidateeUserAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		return this.txSender.send(
			wrapInTx(await this.getLiquidateIx(liquidateeUserAccountPublicKey)),
			[],
			this.opts
		);
	}

	public async getLiquidateIx(
		liquidateeUserAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const liquidateeUserAccount: any = await this.program.account.user.fetch(
			liquidateeUserAccountPublicKey
		);
		const liquidateePositions: any =
			await this.program.account.userPositions.fetch(
				liquidateeUserAccount.positions
			);
		const markets = this.getMarketsAccount();

		const remainingAccounts = [];
		for (const position of liquidateePositions.positions) {
			if (!position.baseAssetAmount.eq(new BN(0))) {
				const market = markets.markets[position.marketIndex.toNumber()];
				remainingAccounts.push({
					pubkey: market.amm.oracle,
					isWritable: false,
					isSigner: false,
				});
			}
		}

		const state = this.getStateAccount();
		return await this.program.instruction.liquidate({
			accounts: {
				state: await this.getStatePublicKey(),
				authority: this.wallet.publicKey,
				user: liquidateeUserAccountPublicKey,
				liquidator: userAccountPublicKey,
				collateralVault: state.collateralVault,
				collateralVaultAuthority: state.collateralVaultAuthority,
				insuranceVault: state.insuranceVault,
				insuranceVaultAuthority: state.insuranceVaultAuthority,
				tokenProgram: TOKEN_PROGRAM_ID,
				markets: state.markets,
				userPositions: liquidateeUserAccount.positions,
				tradeHistory: state.tradeHistory,
				liquidationHistory: state.liquidationHistory,
				fundingPaymentHistory: state.fundingPaymentHistory,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public async updateFundingRate(
		oracle: PublicKey,
		marketIndex: BN
	): Promise<TransactionSignature> {
		return this.txSender.send(
			wrapInTx(await this.getUpdateFundingRateIx(oracle, marketIndex)),
			[],
			this.opts
		);
	}

	public async getUpdateFundingRateIx(
		oracle: PublicKey,
		marketIndex: BN
	): Promise<TransactionInstruction> {
		const state = this.getStateAccount();
		return await this.program.instruction.updateFundingRate(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				markets: state.markets,
				oracle: oracle,
				fundingRateHistory: state.fundingRateHistory,
			},
		});
	}

	public async settleFundingPayment(
		userAccount: PublicKey,
		userPositionsAccount: PublicKey
	): Promise<TransactionSignature> {
		return this.txSender.send(
			wrapInTx(
				await this.getSettleFundingPaymentIx(userAccount, userPositionsAccount)
			),
			[],
			this.opts
		);
	}

	public async getSettleFundingPaymentIx(
		userAccount: PublicKey,
		userPositionsAccount: PublicKey
	): Promise<TransactionInstruction> {
		const state = this.getStateAccount();
		return await this.program.instruction.settleFundingPayment({
			accounts: {
				state: await this.getStatePublicKey(),
				markets: state.markets,
				user: userAccount,
				userPositions: userPositionsAccount,
				fundingPaymentHistory: state.fundingPaymentHistory,
			},
		});
	}

	public triggerEvent(eventName: keyof ClearingHouseAccountEvents, data?: any) {
		this.eventEmitter.emit(eventName, data);
	}
}
