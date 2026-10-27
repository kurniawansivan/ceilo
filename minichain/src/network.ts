import type { Block } from "./block.ts";
import type { PoolAddOutcome } from "./mempool.ts";
import type { NetworkMessage, NetworkNode, Outgoing } from "./node.ts";
import type { SignedTransaction } from "./transaction.ts";

const DEFAULT_MAXIMUM_DELIVERIES = 100_000;

/** How deliverAll picks messages: first in, first out, or at random from a generator that returns [0, 1). */
export type DeliveryOptions = {
  readonly random?: () => number;
  readonly maximumDeliveries?: number;
};

/** A message on its way: who sent it, who it is for, and what it says. */
type QueuedMessage = {
  readonly sender: string;
  readonly recipient: string;
  readonly message: NetworkMessage;
};

/** Nodes joined by links, and the messages in flight between them, delivered only when asked. */
export class SimulatedNetwork {
  readonly #nodes = new Map<string, NetworkNode>();
  readonly #queue: QueuedMessage[] = [];

  /** Puts the nodes on the network, throwing if two share an identifier. */
  constructor(nodes: readonly NetworkNode[]) {
    for (const node of nodes) {
      if (this.#nodes.has(node.identifier)) {
        throw new RangeError("two nodes share an identifier");
      }
      this.#nodes.set(node.identifier, node);
    }
  }

  /** Finds a node by identifier, throwing if there is none. */
  node(identifier: string): NetworkNode {
    const node = this.#nodes.get(identifier);
    if (node === undefined) {
      throw new RangeError(`no node is called ${identifier}`);
    }
    return node;
  }

  /** How many messages are in flight. */
  get pendingCount(): number {
    return this.#queue.length;
  }

  /** Links two nodes as peers, and has each tell the other which block it follows. */
  connect(first: string, second: string): void {
    const firstNode = this.node(first);
    const secondNode = this.node(second);
    firstNode.addPeer(second);
    secondNode.addPeer(first);
    this.#enqueue(first, firstNode.announceTip(second));
    this.#enqueue(second, secondNode.announceTip(first));
  }

  /** Cuts the link between two nodes, and drops the messages in flight between them. */
  disconnect(first: string, second: string): void {
    this.node(first).removePeer(second);
    this.node(second).removePeer(first);
    const kept = this.#queue.filter(
      (queued) =>
        !(
          (queued.sender === first && queued.recipient === second) ||
          (queued.sender === second && queued.recipient === first)
        ),
    );
    this.#queue.splice(0, this.#queue.length, ...kept);
  }

  /** Gives a node a transaction from its own user, and puts what it sends on the wire. */
  submitTransaction(identifier: string, transaction: SignedTransaction): PoolAddOutcome {
    const result = this.node(identifier).submitTransaction(transaction);
    this.#enqueue(identifier, result.outgoing);
    return result.outcome;
  }

  /** Has a node mine a block, and puts what it sends on the wire. */
  mineBlock(identifier: string, attemptCount: number): Block | undefined {
    const result = this.node(identifier).mineBlock(attemptCount);
    this.#enqueue(identifier, result.outgoing);
    return result.block;
  }

  /** Delivers messages, and the ones they cause, until none are left; returns how many were delivered. */
  deliverAll(options: DeliveryOptions = {}): number {
    const maximumDeliveries = options.maximumDeliveries ?? DEFAULT_MAXIMUM_DELIVERIES;
    let delivered = 0;
    while (this.#queue.length > 0) {
      if (delivered >= maximumDeliveries) {
        throw new RangeError("messages are still in flight after the most deliveries allowed");
      }
      const index =
        options.random === undefined ? 0 : Math.floor(options.random() * this.#queue.length);
      // The splice takes the one message out of the queue.
      for (const queued of this.#queue.splice(index, 1)) {
        const answer = this.node(queued.recipient).receive(queued.sender, queued.message);
        this.#enqueue(queued.recipient, answer);
        delivered++;
      }
    }
    return delivered;
  }

  /** Puts a node's outgoing messages in flight. */
  #enqueue(sender: string, outgoing: readonly Outgoing[]): void {
    for (const { recipient, message } of outgoing) {
      this.#queue.push({ sender, recipient, message });
    }
  }
}
