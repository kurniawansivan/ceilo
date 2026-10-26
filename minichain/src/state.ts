import type { Block } from "./block.ts";
import { toHexadecimal } from "./hash.ts";
import { ADDRESS_LENGTH, type Address } from "./keys.ts";
import { recoverSender, type SignedTransaction } from "./transaction.ts";

/** The largest value a balance, amount, fee, nonce or chain identifier may hold: 2^256 - 1. */
export const MAXIMUM_VALUE = 2n ** 256n - 1n;

/** The smallest fee a transaction may pay, so no account can be created or kept busy for free. */
export const MINIMUM_FEE = 1n;

/** What an address holds: coins, and how many transactions it has sent. */
export type Account = {
  readonly balance: bigint;
  readonly nonce: bigint;
};

/** Every non-empty account, by lowercase hexadecimal address, on one chain. */
export type ChainState = {
  readonly chainIdentifier: bigint;
  readonly accounts: ReadonlyMap<string, Account>;
};

/** Coins that exist from the start, given to an address by the genesis state. */
export type GenesisAllocation = {
  readonly address: Address;
  readonly balance: bigint;
};

/** The first rule a transaction breaks, in the order the rules are checked. */
export type TransactionRejection =
  | "malformed-transaction"
  | "value-out-of-range"
  | "wrong-chain"
  | "fee-too-low"
  | "invalid-signature"
  | "nonce-mismatch"
  | "insufficient-balance";

/** The outcome of applying a transaction: the new state, or the reason it was rejected. */
export type TransactionApplication =
  | { readonly valid: true; readonly state: ChainState }
  | { readonly valid: false; readonly reason: TransactionRejection };

/** The outcome of applying a block: the new state, or the first bad transaction and its reason. */
export type BlockApplication =
  | { readonly valid: true; readonly state: ChainState }
  | {
      readonly valid: false;
      readonly transactionIndex: number;
      readonly reason: TransactionRejection;
    };

const EMPTY_ACCOUNT: Account = { balance: 0n, nonce: 0n };

/** Gives an address the text key under which its account is stored. */
function accountKey(address: Address): string {
  return toHexadecimal(address);
}

/** Tells whether a value lies between zero and the maximum value. */
function isInRange(value: bigint): boolean {
  return value >= 0n && value <= MAXIMUM_VALUE;
}

/** Throws unless the address has exactly the length of an address. */
function assertAddressLength(address: Address, name: string): void {
  if (address.length !== ADDRESS_LENGTH) {
    throw new RangeError(`${name} must be ${ADDRESS_LENGTH} bytes`);
  }
}

/** Reads an account, treating an address with no entry as an empty account. */
function readAccount(accounts: ReadonlyMap<string, Account>, address: Address): Account {
  return accounts.get(accountKey(address)) ?? EMPTY_ACCOUNT;
}

/** Stores an account, dropping an empty one so that equal states look equal. */
function writeAccount(accounts: Map<string, Account>, address: Address, account: Account): void {
  if (account.balance === 0n && account.nonce === 0n) {
    accounts.delete(accountKey(address));
  } else {
    accounts.set(accountKey(address), account);
  }
}

/** Adds coins to an account, reading it fresh so earlier changes in the same step are kept. */
function creditAccount(accounts: Map<string, Account>, address: Address, amount: bigint): void {
  const account = readAccount(accounts, address);
  writeAccount(accounts, address, { ...account, balance: account.balance + amount });
}

/** Checks that every field has the type and length a transaction needs, as untyped input might not. */
function isWellFormed(transaction: SignedTransaction): boolean {
  return (
    typeof transaction.chainIdentifier === "bigint" &&
    typeof transaction.nonce === "bigint" &&
    typeof transaction.amount === "bigint" &&
    typeof transaction.fee === "bigint" &&
    transaction.recipient instanceof Uint8Array &&
    transaction.recipient.length === ADDRESS_LENGTH &&
    transaction.signature instanceof Uint8Array
  );
}

/** Recovers the sender, returning undefined instead of throwing when the signature is invalid. */
function tryRecoverSender(transaction: SignedTransaction): Address | undefined {
  try {
    return recoverSender(transaction);
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      return undefined;
    }
    throw error;
  }
}

/** Checks a transaction against the accounts and applies it if it passes, else returns why not. */
function applyToAccounts(
  accounts: Map<string, Account>,
  chainIdentifier: bigint,
  transaction: SignedTransaction,
  beneficiary: Address,
): TransactionRejection | undefined {
  if (!isWellFormed(transaction)) {
    return "malformed-transaction";
  }
  const values = [
    transaction.chainIdentifier,
    transaction.nonce,
    transaction.amount,
    transaction.fee,
  ];
  if (!values.every((value) => isInRange(value))) {
    return "value-out-of-range";
  }
  if (transaction.chainIdentifier !== chainIdentifier) {
    return "wrong-chain";
  }
  if (transaction.fee < MINIMUM_FEE) {
    return "fee-too-low";
  }
  const sender = tryRecoverSender(transaction);
  if (sender === undefined) {
    return "invalid-signature";
  }
  const senderAccount = readAccount(accounts, sender);
  if (transaction.nonce !== senderAccount.nonce) {
    return "nonce-mismatch";
  }
  const totalCost = transaction.amount + transaction.fee;
  if (senderAccount.balance < totalCost) {
    return "insufficient-balance";
  }

  writeAccount(accounts, sender, {
    balance: senderAccount.balance - totalCost,
    nonce: senderAccount.nonce + 1n,
  });
  creditAccount(accounts, transaction.recipient, transaction.amount);
  creditAccount(accounts, beneficiary, transaction.fee);
  return undefined;
}

/** Creates the first state of a chain, rejecting out-of-range or repeated allocations. */
export function createGenesisState(
  chainIdentifier: bigint,
  allocations: readonly GenesisAllocation[],
): ChainState {
  if (!isInRange(chainIdentifier)) {
    throw new RangeError("chain identifier is out of range");
  }
  const accounts = new Map<string, Account>();
  const allocatedKeys = new Set<string>();
  for (const allocation of allocations) {
    assertAddressLength(allocation.address, "allocated address");
    if (!isInRange(allocation.balance)) {
      throw new RangeError("allocated balance is out of range");
    }
    if (allocatedKeys.has(accountKey(allocation.address))) {
      throw new RangeError("an address cannot be allocated twice");
    }
    allocatedKeys.add(accountKey(allocation.address));
    writeAccount(accounts, allocation.address, { balance: allocation.balance, nonce: 0n });
  }
  return { chainIdentifier, accounts };
}

/** Reads an account from the state, treating an unknown address as empty. */
export function getAccount(state: ChainState, address: Address): Account {
  return readAccount(state.accounts, address);
}

/** Adds up every balance; fees only move coins, so this never changes after genesis. */
export function computeTotalSupply(state: ChainState): bigint {
  let totalSupply = 0n;
  for (const account of state.accounts.values()) {
    totalSupply += account.balance;
  }
  return totalSupply;
}

/** Applies one transaction to a copy of the state, paying its fee to the beneficiary. */
export function applyTransaction(
  state: ChainState,
  transaction: SignedTransaction,
  beneficiary: Address,
): TransactionApplication {
  assertAddressLength(beneficiary, "beneficiary");
  const accounts = new Map(state.accounts);
  const reason = applyToAccounts(accounts, state.chainIdentifier, transaction, beneficiary);
  if (reason !== undefined) {
    return { valid: false, reason };
  }
  return { valid: true, state: { chainIdentifier: state.chainIdentifier, accounts } };
}

/** Applies a block's transactions in order to a copy of the state, all or none. */
export function applyBlock(state: ChainState, block: Block): BlockApplication {
  const { beneficiary } = block.header;
  assertAddressLength(beneficiary, "beneficiary");
  const accounts = new Map(state.accounts);
  for (const [transactionIndex, transaction] of block.transactions.entries()) {
    const reason = applyToAccounts(accounts, state.chainIdentifier, transaction, beneficiary);
    if (reason !== undefined) {
      return { valid: false, transactionIndex, reason };
    }
  }
  return { valid: true, state: { chainIdentifier: state.chainIdentifier, accounts } };
}
