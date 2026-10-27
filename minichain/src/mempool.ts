import type { TipChange } from "./blocktree.ts";
import { type Hash, toHexadecimal } from "./hash.ts";
import type { Address } from "./keys.ts";
import {
  applyTransaction,
  type ChainState,
  checkTransactionForPool,
  type TransactionRejection,
} from "./state.ts";
import { hashSignedTransaction, type SignedTransaction } from "./transaction.ts";

const DEFAULT_CAPACITY = 200;

/** Why the pool turned a transaction away: a rule a block would enforce, or a rule of the pool itself. */
export type PoolRejection =
  | TransactionRejection
  | "already-known"
  | "replacement-fee-too-low"
  | "pool-full";

/** What happened to a transaction offered to the pool. */
export type PoolAddOutcome =
  | { readonly status: "added" }
  | { readonly status: "replaced"; readonly replaced: SignedTransaction }
  | { readonly status: "rejected"; readonly reason: PoolRejection };

/** A pooled transaction with the text key of the address that sent it. */
type PoolEntry = {
  readonly transaction: SignedTransaction;
  readonly sender: string;
};

/** Orders transactions by fee, highest first. */
function compareByFeeDescending(left: SignedTransaction, right: SignedTransaction): number {
  if (left.fee === right.fee) {
    return 0;
  }
  return left.fee > right.fee ? -1 : 1;
}

/** The valid transactions a node has heard of and no block has taken yet, held within a fixed capacity. */
export class Mempool {
  readonly #capacity: number;
  // A Map remembers insertion order, which is the order the transactions arrived in.
  readonly #entries = new Map<string, PoolEntry>();

  /** Makes an empty pool, throwing unless it has room for at least one transaction. */
  constructor(capacity: number = DEFAULT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("the pool must have room for at least one whole transaction");
    }
    this.#capacity = capacity;
  }

  /** How many transactions the pool holds. */
  get size(): number {
    return this.#entries.size;
  }

  /** Tells whether the pool holds the transaction with this hash. */
  has(hash: Hash): boolean {
    return this.#entries.has(toHexadecimal(hash));
  }

  /** Lists every pooled transaction, in the order it arrived. */
  pending(): SignedTransaction[] {
    return [...this.#entries.values()].map((entry) => entry.transaction);
  }

  /** Offers a transaction to the pool, checked against the state of the chain tip. */
  add(state: ChainState, transaction: SignedTransaction): PoolAddOutcome {
    const check = checkTransactionForPool(state, transaction);
    if (!check.valid) {
      return { status: "rejected", reason: check.reason };
    }
    const key = toHexadecimal(hashSignedTransaction(transaction));
    if (this.#entries.has(key)) {
      return { status: "rejected", reason: "already-known" };
    }

    const entry: PoolEntry = { transaction, sender: toHexadecimal(check.sender) };
    const rival = this.#findRival(entry);
    if (rival !== undefined) {
      const [rivalKey, rivalEntry] = rival;
      if (transaction.fee <= rivalEntry.transaction.fee) {
        return { status: "rejected", reason: "replacement-fee-too-low" };
      }
      this.#entries.delete(rivalKey);
      this.#entries.set(key, entry);
      return { status: "replaced", replaced: rivalEntry.transaction };
    }

    if (this.#entries.size >= this.#capacity) {
      const evictableKey = this.#findEvictable(transaction.fee);
      if (evictableKey === undefined) {
        return { status: "rejected", reason: "pool-full" };
      }
      this.#entries.delete(evictableKey);
    }
    this.#entries.set(key, entry);
    return { status: "added" };
  }

  /** Picks the transactions for the next block: best fee first, every one of them runnable in that order. */
  select(state: ChainState, beneficiary: Address, maximumCount: number): SignedTransaction[] {
    if (!Number.isInteger(maximumCount) || maximumCount < 0) {
      throw new RangeError("the maximum count must be a whole number, zero or more");
    }
    // Sorting is stable, so transactions that pay the same fee stay in the order they arrived.
    const remaining = this.pending().sort(compareByFeeDescending);
    const selected: SignedTransaction[] = [];
    let working = state;
    let progressed = true;

    while (progressed && selected.length < maximumCount) {
      progressed = false;
      for (const [position, transaction] of remaining.entries()) {
        const applied = applyTransaction(working, transaction, beneficiary);
        if (applied.valid) {
          selected.push(transaction);
          working = applied.state;
          // A taken transaction can never run again, so dropping it only saves re-checking it.
          remaining.splice(position, 1);
          progressed = true;
          break;
        }
      }
    }
    return selected;
  }

  /** Brings the pool up to date with a new chain tip: takes back undone transactions, drops those now dead. */
  applyTipChange(state: ChainState, tipChange: TipChange): void {
    if (tipChange.kind === "reorganized") {
      for (const block of tipChange.detached) {
        for (const transaction of block.transactions) {
          this.add(state, transaction);
        }
      }
    }
    for (const [key, entry] of this.#entries) {
      if (!checkTransactionForPool(state, entry.transaction).valid) {
        this.#entries.delete(key);
      }
    }
  }

  /** Finds the pooled entry from the same sender with the same nonce, if there is one. */
  #findRival(newcomer: PoolEntry): [string, PoolEntry] | undefined {
    for (const [key, entry] of this.#entries) {
      if (
        entry.sender === newcomer.sender &&
        entry.transaction.nonce === newcomer.transaction.nonce
      ) {
        return [key, entry];
      }
    }
    return undefined;
  }

  /** Finds the key to drop for a newcomer paying this fee: the lowest fee below it, the newest on a tie. */
  #findEvictable(fee: bigint): string | undefined {
    let evictableKey: string | undefined;
    let lowestFee = fee;
    for (const [key, entry] of this.#entries) {
      const entryFee = entry.transaction.fee;
      if (entryFee < lowestFee || (entryFee === lowestFee && evictableKey !== undefined)) {
        evictableKey = key;
        lowestFee = entryFee;
      }
    }
    return evictableKey;
  }
}
