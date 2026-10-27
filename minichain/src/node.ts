import { assembleBlock } from "./assembly.ts";
import type { Block } from "./block.ts";
import { BlockTree, type TipChange } from "./blocktree.ts";
import { type ConsensusRules, isTimestampNotTooFarAhead } from "./consensus.ts";
import type { Hash } from "./hash.ts";
import type { Address } from "./keys.ts";
import { Mempool, type PoolAddOutcome } from "./mempool.ts";
import type { Genesis } from "./state.ts";
import type { SignedTransaction } from "./transaction.ts";

/** What one node tells another: a transaction, a block, or a request for a block by its hash. */
export type NetworkMessage =
  | { readonly kind: "transaction"; readonly transaction: SignedTransaction }
  | { readonly kind: "block"; readonly block: Block }
  | { readonly kind: "request-block"; readonly hash: Hash };

/** A message a node wants sent, and the peer it is for. */
export type Outgoing = {
  readonly recipient: string;
  readonly message: NetworkMessage;
};

/** Everything a node needs to start: who it is, the chain it follows, who it mines for, and its clock. */
export type NetworkNodeParameters = {
  readonly identifier: string;
  readonly genesis: Genesis;
  readonly rules: ConsensusRules;
  readonly beneficiary: Address;
  /** Seconds since the Unix epoch, as this node's clock reads them. */
  readonly clock: () => bigint;
};

/** A full node: it keeps every block it has seen, a pool of waiting transactions, and a list of peers. */
export class NetworkNode {
  readonly identifier: string;
  readonly tree: BlockTree;
  readonly pool: Mempool;
  readonly #rules: ConsensusRules;
  readonly #beneficiary: Address;
  readonly #clock: () => bigint;
  // A Set remembers insertion order, so peers are listed in the order they were added.
  readonly #peers = new Set<string>();

  /** Starts a node at the genesis block with an empty pool and no peers. */
  constructor(parameters: NetworkNodeParameters) {
    this.identifier = parameters.identifier;
    this.tree = new BlockTree(parameters.genesis, parameters.rules);
    this.pool = new Mempool();
    this.#rules = parameters.rules;
    this.#beneficiary = parameters.beneficiary;
    this.#clock = parameters.clock;
  }

  /** Lists the peers this node talks to, in the order they were added. */
  get peers(): string[] {
    return [...this.#peers];
  }

  /** Makes another node a peer, throwing if it is this node itself. */
  addPeer(peer: string): void {
    if (peer === this.identifier) {
      throw new RangeError("a node cannot be its own peer");
    }
    this.#peers.add(peer);
  }

  /** Stops talking to a peer. */
  removePeer(peer: string): void {
    this.#peers.delete(peer);
  }

  /** Tells a peer which block this node follows, so the peer can catch up if it is behind. */
  announceTip(recipient: string): Outgoing[] {
    return [{ recipient, message: { kind: "block", block: this.tree.tip.block } }];
  }

  /** Takes a transaction from this node's own user, and sends it to every peer if the pool keeps it. */
  submitTransaction(transaction: SignedTransaction): {
    readonly outcome: PoolAddOutcome;
    readonly outgoing: Outgoing[];
  } {
    const outcome = this.pool.add(this.tree.tip.state, transaction);
    if (outcome.status === "rejected") {
      return { outcome, outgoing: [] };
    }
    return { outcome, outgoing: this.#broadcast({ kind: "transaction", transaction }) };
  }

  /** Mines the next block from the pool, takes it as its own tip, and sends it to every peer. */
  mineBlock(attemptCount: number): {
    readonly block: Block | undefined;
    readonly outgoing: Outgoing[];
  } {
    const timestamp = this.#clock();
    const earliestTimestamp = this.tree.tip.block.header.timestamp + 1n;
    const block = assembleBlock(this.tree, this.pool, {
      beneficiary: this.#beneficiary,
      timestamp: timestamp > earliestTimestamp ? timestamp : earliestTimestamp,
      attemptCount,
    });
    if (block === undefined) {
      return { block: undefined, outgoing: [] };
    }
    // A block this node mined counts as coming from itself, so it goes to every peer.
    return { block, outgoing: this.#takeBlock(block, this.identifier) };
  }

  /** Handles a message from a peer and returns what to send in answer. */
  receive(sender: string, message: NetworkMessage): Outgoing[] {
    switch (message.kind) {
      case "transaction": {
        const outcome = this.pool.add(this.tree.tip.state, message.transaction);
        return outcome.status === "rejected" ? [] : this.#broadcast(message, sender);
      }
      case "block":
        if (
          !isTimestampNotTooFarAhead(message.block.header.timestamp, this.#clock(), this.#rules)
        ) {
          return [];
        }
        return this.#takeBlock(message.block, sender);
      case "request-block": {
        const stored = this.tree.get(message.hash);
        if (stored === undefined) {
          return [];
        }
        return [{ recipient: sender, message: { kind: "block", block: stored.block } }];
      }
    }
  }

  /** Offers a block to the tree: passes on the branch it made best, asks for a missing parent, or does nothing. */
  #takeBlock(block: Block, sender: string): Outgoing[] {
    const outcome = this.tree.addBlock(block);
    if (outcome.status === "orphan") {
      const hash = block.header.previousBlockHash;
      return [{ recipient: sender, message: { kind: "request-block", hash } }];
    }
    if (outcome.status !== "added") {
      return [];
    }
    this.pool.applyTipChange(this.tree.tip.state, outcome.tipChange);
    return this.#blocksToPassOn(block, outcome.tipChange).flatMap((passedOn) =>
      this.#broadcast({ kind: "block", block: passedOn }, sender),
    );
  }

  /** Lists the blocks peers should hear about: the new best branch, oldest first, or just the block if none. */
  #blocksToPassOn(block: Block, tipChange: TipChange): readonly Block[] {
    if (tipChange.kind === "unchanged") {
      return [block];
    }
    return tipChange.attached;
  }

  /** Addresses a message to every peer except one. */
  #broadcast(message: NetworkMessage, exceptPeer?: string): Outgoing[] {
    return this.peers
      .filter((peer) => peer !== exceptPeer)
      .map((recipient) => ({ recipient, message }));
  }
}
