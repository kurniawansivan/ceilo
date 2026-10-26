import { equalBytes } from "@noble/curves/utils.js";

import { tryCompute } from "./attempt.ts";
import { type Block, type BlockHeader, createBlock, createGenesisBlock } from "./block.ts";
import { encode } from "./encoding.ts";
import { fromHexadecimal, type Hash, toHexadecimal } from "./hash.ts";
import { ADDRESS_LENGTH, type Address } from "./keys.ts";
import {
  computeMerkleRoot,
  createMerkleProof,
  type MerkleProof,
  verifyMerkleProof,
} from "./merkle.ts";
import { recoverSender, type SignedTransaction } from "./transaction.ts";

const CHAIN_LEAF_DOMAIN = "ceilo/chain-identifier";
const ACCOUNT_LEAF_DOMAIN = "ceilo/account";

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

/** An account's balance and nonce, with the Merkle proof that they are part of a state root. */
export type AccountProof = {
  readonly account: Account;
  readonly proof: MerkleProof;
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

/** Transactions applied in order to a state: the new state, or the first bad transaction. */
export type TransactionsApplication =
  | { readonly valid: true; readonly state: ChainState }
  | {
      readonly valid: false;
      readonly transactionIndex: number;
      readonly reason: TransactionRejection;
    };

/** The outcome of applying a block: the new state, a bad transaction, or a wrong state root. */
export type BlockApplication =
  | TransactionsApplication
  | { readonly valid: false; readonly reason: "state-root-mismatch" };

/** Everything needed to produce the next block from the state that its parent left. */
export type BlockProductionRequest = {
  readonly parentState: ChainState;
  readonly parentHeader: BlockHeader;
  readonly transactions: readonly SignedTransaction[];
  readonly timestamp: bigint;
  readonly beneficiary: Address;
  /** The target the block must meet; the parent's target if left out. */
  readonly target?: bigint;
};

/** The outcome of producing a block: the block with the state it leaves, or the first bad transaction. */
export type BlockProduction =
  | { readonly valid: true; readonly block: Block; readonly state: ChainState }
  | {
      readonly valid: false;
      readonly transactionIndex: number;
      readonly reason: TransactionRejection;
    };

/** Everything that defines a chain from its first moment. */
export type GenesisParameters = {
  readonly chainIdentifier: bigint;
  readonly timestamp: bigint;
  /** The first target: how hard the first mined block is to find. */
  readonly target: bigint;
  readonly allocations: readonly GenesisAllocation[];
};

/** The genesis block together with the state it commits to. */
export type Genesis = {
  readonly block: Block;
  readonly state: ChainState;
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
  const sender = tryCompute(() => recoverSender(transaction));
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

/** Applies transactions in order to a copy of the state, all or none, paying fees to the beneficiary. */
function applyTransactions(
  state: ChainState,
  transactions: readonly SignedTransaction[],
  beneficiary: Address,
): TransactionsApplication {
  assertAddressLength(beneficiary, "beneficiary");
  const accounts = new Map(state.accounts);
  for (const [transactionIndex, transaction] of transactions.entries()) {
    const reason = applyToAccounts(accounts, state.chainIdentifier, transaction, beneficiary);
    if (reason !== undefined) {
      return { valid: false, transactionIndex, reason };
    }
  }
  return { valid: true, state: { chainIdentifier: state.chainIdentifier, accounts } };
}

/** Encodes an account and its address as the bytes of one leaf of the state tree. */
function encodeAccountLeaf(address: Address, account: Account): Uint8Array {
  return encode([ACCOUNT_LEAF_DOMAIN, address, account.balance, account.nonce]);
}

/** Lists the account entries sorted by address key, the order their leaves take in the state tree. */
function sortedAccountEntries(state: ChainState): [string, Account][] {
  return [...state.accounts.entries()].sort(([leftKey], [rightKey]) =>
    leftKey < rightKey ? -1 : 1,
  );
}

/** Lists the leaves of the state tree: the chain identifier first, then each account in address order. */
function listStateLeaves(state: ChainState): Uint8Array[] {
  const accountLeaves = sortedAccountEntries(state).map(([key, account]) =>
    encodeAccountLeaf(fromHexadecimal(key), account),
  );
  return [encode([CHAIN_LEAF_DOMAIN, state.chainIdentifier]), ...accountLeaves];
}

/** Computes the Merkle root over the chain identifier and every account, sorted by address. */
export function computeStateRoot(state: ChainState): Hash {
  return computeMerkleRoot(listStateLeaves(state));
}

/** Builds a proof of an account's balance and nonce, or undefined if the state has no such account. */
export function createAccountProof(state: ChainState, address: Address): AccountProof | undefined {
  const account = state.accounts.get(accountKey(address));
  if (account === undefined) {
    return undefined;
  }
  const accountPosition = sortedAccountEntries(state).findIndex(
    ([key]) => key === accountKey(address),
  );
  // Leaf 0 is the chain identifier, so account leaves start at position 1.
  return { account, proof: createMerkleProof(listStateLeaves(state), accountPosition + 1) };
}

/** Checks a claimed account against a state root alone, returning false for any malformed claim. */
export function verifyAccountProof(
  stateRoot: Hash,
  address: Address,
  accountProof: AccountProof,
): boolean {
  const leaf = tryCompute(() => encodeAccountLeaf(address, accountProof.account));
  return leaf !== undefined && verifyMerkleProof(leaf, accountProof.proof, stateRoot);
}

/** Creates the genesis state and a genesis block whose header commits to it, allocations included. */
export function createGenesis(parameters: GenesisParameters): Genesis {
  const state = createGenesisState(parameters.chainIdentifier, parameters.allocations);
  const block = createGenesisBlock({
    timestamp: parameters.timestamp,
    stateRoot: computeStateRoot(state),
    target: parameters.target,
  });
  return { block, state };
}

/** Applies a block to a copy of the state, all or none, and checks the root it claims for the result. */
export function applyBlock(state: ChainState, block: Block): BlockApplication {
  const applied = applyTransactions(state, block.transactions, block.header.beneficiary);
  if (!applied.valid) {
    return applied;
  }
  if (!equalBytes(computeStateRoot(applied.state), block.header.stateRoot)) {
    return { valid: false, reason: "state-root-mismatch" };
  }
  return applied;
}

/** Builds the next block from its parent's state, committing to the state its transactions leave. */
export function produceBlock(request: BlockProductionRequest): BlockProduction {
  if (!equalBytes(computeStateRoot(request.parentState), request.parentHeader.stateRoot)) {
    throw new RangeError("parent state does not match the state root of the parent header");
  }
  const applied = applyTransactions(request.parentState, request.transactions, request.beneficiary);
  if (!applied.valid) {
    return applied;
  }
  const block = createBlock({
    parentHeader: request.parentHeader,
    transactions: request.transactions,
    timestamp: request.timestamp,
    beneficiary: request.beneficiary,
    stateRoot: computeStateRoot(applied.state),
    ...(request.target === undefined ? {} : { target: request.target }),
  });
  return { valid: true, block, state: applied.state };
}
