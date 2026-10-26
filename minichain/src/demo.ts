import { type Block, createBlock, hashBlockHeader } from "./block.ts";
import { checkChain, replayChain } from "./chain.ts";
import { type Hash, toHexadecimal } from "./hash.ts";
import { type Address, deriveAddress, derivePublicKey, type PrivateKey } from "./keys.ts";
import {
  applyTransaction,
  type ChainState,
  computeTotalSupply,
  createAccountProof,
  createGenesis,
  getAccount,
  MINIMUM_FEE,
  produceBlock,
  verifyAccountProof,
} from "./state.ts";
import { elementAt, flipFirstBit, privateKeyWithValue } from "./testing.ts";
import { type SignedTransaction, signTransaction } from "./transaction.ts";

const CHAIN_IDENTIFIER = 1337n;
const GENESIS_TIMESTAMP = 1_700_000_000n;
const BLOCK_INTERVAL_IN_SECONDS = 12n;
const BLOCK_COUNT = 5;
const ATTACKED_BLOCK_INDEX = 2;
const ALICE_ALLOCATION = 1_000n;
const BOB_ALLOCATION = 500n;
const INFLATION_CLAIMED_BY_LIAR = 1_000n;

/** Where a bad chain or transaction was stopped, from the earliest layer to "never". */
export type DetectionLayer =
  | "chain structure"
  | "transaction rules"
  | "state replay"
  | "not detected";

/** One attack, what it tried, and which layer caught it and why. */
export type ScenarioResult = {
  readonly id: string;
  readonly title: string;
  readonly attack: string;
  readonly detectedBy: DetectionLayer;
  readonly reason: string;
  readonly detail: string;
};

/** The facts of one block that the overview prints. */
export type BlockSummary = {
  readonly height: bigint;
  readonly hash: Hash;
  readonly transactionCount: number;
  readonly stateRoot: Hash;
};

/** A participant's balance and nonce at the tip of the honest chain. */
export type ParticipantSummary = {
  readonly name: string;
  readonly balance: bigint;
  readonly nonce: bigint;
};

/** The honest chain at a glance. */
export type ChainOverview = {
  readonly genesisHash: Hash;
  readonly blocks: readonly BlockSummary[];
  readonly participants: readonly ParticipantSummary[];
  readonly initialSupply: bigint;
  readonly finalSupply: bigint;
  readonly honestChainReplays: boolean;
};

/** A light client checking a balance against a block header, and a liar trying to inflate it. */
export type BalanceProofResult = {
  readonly participantName: string;
  readonly balance: bigint;
  readonly nonce: bigint;
  readonly proofSteps: number;
  readonly genuineClaimAccepted: boolean;
  readonly inflatedBalance: bigint;
  readonly inflatedClaimAccepted: boolean;
};

/** Everything the demonstration shows. */
export type Demonstration = {
  readonly overview: ChainOverview;
  readonly balanceProof: BalanceProofResult;
  readonly scenarios: readonly ScenarioResult[];
};

/** A name for the output, a key to sign with, and the address that holds the coins. */
type Participant = {
  readonly name: string;
  readonly privateKey: PrivateKey;
  readonly address: Address;
};

/** The honest chain, the state after each block, and the genesis hash that names the chain. */
type HonestChain = {
  readonly chain: Block[];
  readonly states: ChainState[];
  readonly genesisHash: Hash;
};

/** Where a scenario was stopped and why. */
type Outcome = {
  readonly detectedBy: DetectionLayer;
  readonly reason: string;
};

/** Creates a participant from a small integer, so every run uses the same keys and prints the same text. */
const createParticipant = (name: string, keyValue: number): Participant => {
  const privateKey = privateKeyWithValue(keyValue);
  return { name, privateKey, address: deriveAddress(derivePublicKey(privateKey)) };
};

const ALICE = createParticipant("Alice", 1);
const BOB = createParticipant("Bob", 2);
const CAROL = createParticipant("Carol", 3);
const MALLORY = createParticipant("Mallory", 4);
const PARTICIPANTS = [ALICE, BOB, CAROL, MALLORY];

/** Signs a transfer from one participant to another. */
function transfer(
  sender: Participant,
  recipient: Participant,
  amount: bigint,
  fee: bigint,
  nonce: bigint,
  chainIdentifier = CHAIN_IDENTIFIER,
): SignedTransaction {
  return signTransaction(
    { chainIdentifier, nonce, recipient: recipient.address, amount, fee },
    sender.privateKey,
  );
}

/** Lists the two transfers every honest block carries, with the amount from Alice to Bob adjustable. */
function createBlockTransfers(nonce: bigint, amountFromAliceToBob = 50n): SignedTransaction[] {
  return [
    transfer(ALICE, BOB, amountFromAliceToBob, 2n, nonce),
    transfer(BOB, CAROL, 10n, 1n, nonce),
  ];
}

/** Produces the next block from the latest state and adds it, with its state, to the lists. */
function extendChain(
  chain: Block[],
  states: ChainState[],
  transactions: readonly SignedTransaction[],
): void {
  const parent = elementAt(chain, chain.length - 1);
  const production = produceBlock({
    parentState: elementAt(states, states.length - 1),
    parentHeader: parent.header,
    transactions,
    timestamp: parent.header.timestamp + BLOCK_INTERVAL_IN_SECONDS,
    beneficiary: CAROL.address,
  });
  if (!production.valid) {
    throw new Error(`block ${chain.length} could not be produced: ${production.reason}`);
  }
  chain.push(production.block);
  states.push(production.state);
}

/** Creates the genesis block and state, with coins for Alice and Bob only. */
function createDemonstrationGenesis() {
  return createGenesis({
    chainIdentifier: CHAIN_IDENTIFIER,
    timestamp: GENESIS_TIMESTAMP,
    allocations: [
      { address: ALICE.address, balance: ALICE_ALLOCATION },
      { address: BOB.address, balance: BOB_ALLOCATION },
    ],
  });
}

/** Builds the honest chain every scenario starts from. */
function buildHonestChain(): HonestChain {
  const genesis = createDemonstrationGenesis();
  const chain = [genesis.block];
  const states = [genesis.state];
  for (let height = 1; height < BLOCK_COUNT; height++) {
    extendChain(chain, states, createBlockTransfers(BigInt(height - 1)));
  }
  return { chain, states, genesisHash: hashBlockHeader(genesis.block.header) };
}

/** Rebuilds the history from the attacked block on, with Alice paying Bob one coin more each block. */
function buildAlternativeChain(honest: HonestChain): Block[] {
  const chain = honest.chain.slice(0, ATTACKED_BLOCK_INDEX);
  const states = honest.states.slice(0, ATTACKED_BLOCK_INDEX);
  for (let height = ATTACKED_BLOCK_INDEX; height < BLOCK_COUNT; height++) {
    extendChain(chain, states, createBlockTransfers(BigInt(height - 1), 51n));
  }
  return chain;
}

/** Returns a copy of the chain with one block swapped for another. */
function replaceBlockAt(chain: readonly Block[], blockIndex: number, replacement: Block): Block[] {
  return chain.map((block, position) => (position === blockIndex ? replacement : block));
}

/** Re-links every block after a changed one, keeping each block's own contents and claimed state root. */
function relinkAfter(chain: readonly Block[], changedIndex: number, changedBlock: Block): Block[] {
  const relinkedChain = [...chain.slice(0, changedIndex), changedBlock];
  for (let blockIndex = changedIndex + 1; blockIndex < chain.length; blockIndex++) {
    const original = elementAt(chain, blockIndex);
    relinkedChain.push(
      createBlock({
        parentHeader: elementAt(relinkedChain, blockIndex - 1).header,
        transactions: original.transactions,
        timestamp: original.header.timestamp,
        beneficiary: original.header.beneficiary,
        stateRoot: original.header.stateRoot,
      }),
    );
  }
  return relinkedChain;
}

/** Lists a block's transactions with the first one's amount raised by a thousand coins. */
function inflateFirstTransaction(block: Block): SignedTransaction[] {
  const firstTransaction = elementAt(block.transactions, 0);
  return [
    { ...firstTransaction, amount: firstTransaction.amount + 1_000n },
    ...block.transactions.slice(1),
  ];
}

/** Runs the structural check, then the replay, and reports the first layer that stops the chain. */
function detectChainFault(chain: readonly Block[], honest: HonestChain): Outcome {
  const structure = checkChain(chain, honest.genesisHash);
  if (!structure.valid) {
    return {
      detectedBy: "chain structure",
      reason: `${structure.reason} at block ${structure.blockIndex}`,
    };
  }
  const replay = replayChain(chain, honest.genesisHash, elementAt(honest.states, 0));
  if (!replay.valid) {
    return { detectedBy: "state replay", reason: `${replay.reason} at block ${replay.blockIndex}` };
  }
  return {
    detectedBy: "not detected",
    reason: "valid alternative history, which only consensus can reject",
  };
}

/** Applies a transaction to a state and reports whether the transaction rules stop it. */
function detectTransactionFault(state: ChainState, transaction: SignedTransaction): Outcome {
  const result = applyTransaction(state, transaction, CAROL.address);
  if (result.valid) {
    return { detectedBy: "not detected", reason: "the transaction was accepted" };
  }
  return { detectedBy: "transaction rules", reason: result.reason };
}

/** Builds the scenarios that tamper with blocks and chains. */
function runChainScenarios(honest: HonestChain): ScenarioResult[] {
  const { chain } = honest;
  const attackedBlock = elementAt(chain, ATTACKED_BLOCK_INDEX);
  const inflatedTransactions = inflateFirstTransaction(attackedBlock);

  const editedBlock = { ...attackedBlock, transactions: inflatedTransactions };
  const repairedBlock = createBlock({
    parentHeader: elementAt(chain, ATTACKED_BLOCK_INDEX - 1).header,
    transactions: inflatedTransactions,
    timestamp: attackedBlock.header.timestamp,
    beneficiary: attackedBlock.header.beneficiary,
    stateRoot: attackedBlock.header.stateRoot,
  });
  const forgedRootBlock = createBlock({
    parentHeader: elementAt(chain, ATTACKED_BLOCK_INDEX - 1).header,
    transactions: attackedBlock.transactions,
    timestamp: attackedBlock.header.timestamp,
    beneficiary: attackedBlock.header.beneficiary,
    stateRoot: flipFirstBit(attackedBlock.header.stateRoot),
  });
  const redirectedBlock = createBlock({
    parentHeader: elementAt(chain, ATTACKED_BLOCK_INDEX).header,
    transactions: elementAt(chain, ATTACKED_BLOCK_INDEX + 1).transactions,
    timestamp: elementAt(chain, ATTACKED_BLOCK_INDEX + 1).header.timestamp,
    beneficiary: MALLORY.address,
    stateRoot: elementAt(chain, ATTACKED_BLOCK_INDEX + 1).header.stateRoot,
  });

  return [
    {
      id: "edit-amount",
      title: "Edit an amount inside a block",
      attack:
        "Mallory raises a transfer's amount by 1,000 coins in block 2 and leaves the header alone.",
      ...detectChainFault(replaceBlockAt(chain, ATTACKED_BLOCK_INDEX, editedBlock), honest),
      detail: "The Merkle root in block 2's header no longer matches the transactions it holds.",
    },
    {
      id: "edit-amount-and-header",
      title: "Edit an amount and repair the block's header",
      attack: "Mallory also rebuilds block 2's header so the block agrees with itself.",
      ...detectChainFault(replaceBlockAt(chain, ATTACKED_BLOCK_INDEX, repairedBlock), honest),
      detail:
        "Block 2 is now self-consistent, but its hash changed, so block 3's link to it breaks.",
    },
    {
      id: "forge-state-root",
      title: "Forge a state root and re-link every later block",
      attack:
        "Mallory claims a false state root in block 2 and rewrites every later link to match.",
      ...detectChainFault(relinkAfter(chain, ATTACKED_BLOCK_INDEX, forgedRootBlock), honest),
      detail:
        "Every link holds, so the structural check passes; only replaying the transactions exposes the false root.",
    },
    {
      id: "redirect-fees",
      title: "Redirect a block's fees to the attacker",
      attack: "Mallory names herself the beneficiary of block 3 and re-links the blocks after it.",
      ...detectChainFault(relinkAfter(chain, ATTACKED_BLOCK_INDEX + 1, redirectedBlock), honest),
      detail:
        "The fees would land in Mallory's account, so the state after block 3 is not the one its header promises.",
    },
  ];
}

/** Builds the scenario that no check can stop: a complete, consistent rewrite of history. */
function runRewriteScenario(honest: HonestChain): ScenarioResult {
  const alternativeChain = buildAlternativeChain(honest);
  const alternativeTip = hashBlockHeader(
    elementAt(alternativeChain, alternativeChain.length - 1).header,
  );
  const honestTip = hashBlockHeader(elementAt(honest.chain, honest.chain.length - 1).header);

  return {
    id: "rewrite-history",
    title: "Rewrite history consistently from block 2 on",
    attack: "Mallory rebuilds blocks 2 to 4 with correct links, transactions and state roots.",
    ...detectChainFault(alternativeChain, honest),
    detail: `The new tip ${shorten(alternativeTip)} replaces ${shorten(honestTip)}. Nothing in the data is wrong, so every check accepts it; choosing between two valid histories takes consensus (M2).`,
  };
}

/** Builds the scenarios that submit a single bad transaction. */
function runTransactionScenarios(honest: HonestChain): ScenarioResult[] {
  const genesisState = elementAt(honest.states, 0);
  const stateAfterFirstBlock = elementAt(honest.states, 1);
  const aliceTransfer = transfer(ALICE, BOB, 50n, 2n, 0n);
  const alteredTransfer = { ...aliceTransfer, amount: 900n };
  const aliceBalance = getAccount(genesisState, ALICE.address).balance;

  return [
    {
      id: "tamper-after-signing",
      title: "Change a transfer's amount after Alice signed it",
      attack: "Mallory raises the amount of Alice's signed transfer from 50 to 900 coins.",
      ...detectTransactionFault(genesisState, alteredTransfer),
      detail: `The signature now recovers a stranger's address, not Alice's, so Alice still holds ${aliceBalance} coins.`,
    },
    {
      id: "replay-transaction",
      title: "Replay a transfer that already happened",
      attack: "Mallory sends Alice's first transfer, nonce 0, again after block 1 included it.",
      ...detectTransactionFault(stateAfterFirstBlock, aliceTransfer),
      detail: "Alice's nonce is already 1, so nonce 0 can never be used a second time.",
    },
    {
      id: "overspend",
      title: "Spend coins the sender does not have",
      attack: "Mallory, who holds nothing, sends 1 coin to Bob.",
      ...detectTransactionFault(genesisState, transfer(MALLORY, BOB, 1n, 1n, 0n)),
      detail: "Mallory's balance of 0 cannot cover the amount plus the fee.",
    },
    {
      id: "free-transaction",
      title: "Send a transaction for free",
      attack:
        "Mallory sends 0 coins with a fee of 0 to fill blocks and create accounts at no cost.",
      ...detectTransactionFault(genesisState, transfer(MALLORY, BOB, 0n, 0n, 0n)),
      detail: `A minimum fee of ${MINIMUM_FEE} coin means nobody can spam the chain for nothing.`,
    },
    {
      id: "wrong-chain",
      title: "Send a transaction signed for another chain",
      attack: "Mallory submits a transfer Alice signed for chain 1338 to chain 1337.",
      ...detectTransactionFault(genesisState, transfer(ALICE, BOB, 50n, 2n, 0n, 1338n)),
      detail:
        "The chain identifier is part of what Alice signs, so a signature for another chain means nothing here.",
    },
    {
      id: "invalid-signature",
      title: "Send a transaction with a garbage signature",
      attack: "Mallory submits a transfer whose signature is 65 zero bytes.",
      ...detectTransactionFault(genesisState, {
        ...aliceTransfer,
        signature: new Uint8Array(aliceTransfer.signature.length),
      }),
      detail: "An all-zero signature recovers no sender at all.",
    },
  ];
}

/** Summarises the honest chain: its blocks, who holds what, and whether the supply stayed fixed. */
function summariseChain(honest: HonestChain): ChainOverview {
  const finalState = elementAt(honest.states, honest.states.length - 1);
  const replay = replayChain(honest.chain, honest.genesisHash, elementAt(honest.states, 0));
  return {
    genesisHash: honest.genesisHash,
    blocks: honest.chain.map((block) => ({
      height: block.header.height,
      hash: hashBlockHeader(block.header),
      transactionCount: block.transactions.length,
      stateRoot: block.header.stateRoot,
    })),
    participants: PARTICIPANTS.map((participant) => ({
      name: participant.name,
      ...getAccount(finalState, participant.address),
    })),
    initialSupply: computeTotalSupply(elementAt(honest.states, 0)),
    finalSupply: computeTotalSupply(finalState),
    honestChainReplays: replay.valid,
  };
}

/** Has a light client check Bob's balance from the tip's header, then tries an inflated claim. */
function proveBalanceFromHeader(honest: HonestChain): BalanceProofResult {
  const finalState = elementAt(honest.states, honest.states.length - 1);
  const tipHeader = elementAt(honest.chain, honest.chain.length - 1).header;
  const accountProof = createAccountProof(finalState, BOB.address);
  if (accountProof === undefined) {
    throw new Error("Bob has no account at the tip");
  }
  const inflatedBalance = accountProof.account.balance + INFLATION_CLAIMED_BY_LIAR;
  const inflatedProof = {
    ...accountProof,
    account: { ...accountProof.account, balance: inflatedBalance },
  };

  return {
    participantName: BOB.name,
    balance: accountProof.account.balance,
    nonce: accountProof.account.nonce,
    proofSteps: accountProof.proof.length,
    genuineClaimAccepted: verifyAccountProof(tipHeader.stateRoot, BOB.address, accountProof),
    inflatedBalance,
    inflatedClaimAccepted: verifyAccountProof(tipHeader.stateRoot, BOB.address, inflatedProof),
  };
}

/** Builds an honest chain, then every attack and the balance proof, without printing anything. */
export function runDemonstration(): Demonstration {
  const honest = buildHonestChain();
  return {
    overview: summariseChain(honest),
    balanceProof: proveBalanceFromHeader(honest),
    scenarios: [
      ...runChainScenarios(honest),
      ...runTransactionScenarios(honest),
      runRewriteScenario(honest),
    ],
  };
}

/** Shortens a hash for display to its first bytes. */
function shorten(hash: Hash): string {
  return `${toHexadecimal(hash).slice(0, 14)}...`;
}

/** Lays out one row of the block table, padding each column to a fixed width. */
function formatBlockRow(
  height: string,
  blockHash: string,
  transactionCount: string,
  stateRoot: string,
): string {
  return `   ${height.padEnd(7)} ${blockHash.padEnd(17)}  ${transactionCount.padEnd(13)} ${stateRoot}`;
}

/** Lays out the overview: the blocks, then each participant's balance. */
function formatOverview(overview: ChainOverview): string[] {
  return [
    "1. An honest chain",
    `   genesis hash ${shorten(overview.genesisHash)}`,
    formatBlockRow("height", "block hash", "transactions", "state root"),
    ...overview.blocks.map((block) =>
      formatBlockRow(
        String(block.height),
        shorten(block.hash),
        String(block.transactionCount),
        shorten(block.stateRoot),
      ),
    ),
    ...overview.participants.map(
      (participant) =>
        `   ${participant.name.padEnd(8)} balance ${String(participant.balance).padStart(5)}   nonce ${participant.nonce}`,
    ),
    `   total supply: ${overview.initialSupply} at genesis, ${overview.finalSupply} at the tip`,
    `   replaying every block from genesis: ${overview.honestChainReplays ? "valid" : "INVALID"}`,
  ];
}

/** Lays out the light-client balance proof. */
function formatBalanceProof(proof: BalanceProofResult): string[] {
  return [
    "2. A light client checks a balance from a block header alone",
    `   ${proof.participantName} holds ${proof.balance} coins (nonce ${proof.nonce}), proven in ${proof.proofSteps} steps`,
    `   against the tip's state root: ${proof.genuineClaimAccepted ? "accepted" : "rejected"}`,
    `   a claim of ${proof.inflatedBalance} coins instead: ${proof.inflatedClaimAccepted ? "ACCEPTED" : "rejected"}`,
  ];
}

/** Lays out every scenario with the layer that caught it. */
function formatScenarios(scenarios: readonly ScenarioResult[]): string[] {
  return [
    "3. Attacks, and the layer that catches each",
    ...scenarios.flatMap((scenario) => [
      `   [${scenario.detectedBy}] ${scenario.title}`,
      `       attack: ${scenario.attack}`,
      `       result: ${scenario.reason}`,
      `       why:    ${scenario.detail}`,
    ]),
  ];
}

/** Counts how many scenarios each layer caught, and states the lesson. */
function formatSummary(scenarios: readonly ScenarioResult[]): string[] {
  const layers: DetectionLayer[] = [
    "chain structure",
    "transaction rules",
    "state replay",
    "not detected",
  ];
  return [
    "4. Summary",
    ...layers.map(
      (layer) =>
        `   ${layer.padEnd(18)} ${scenarios.filter((scenario) => scenario.detectedBy === layer).length}`,
    ),
    "",
    "   A hash-linked chain is tamper-evident, not tamper-proof: a history rewritten",
    "   consistently from some block on passes every check. Choosing between valid",
    "   histories needs consensus, which is the next module.",
  ];
}

/** Renders the whole demonstration as plain text. */
export function formatDemonstration(demonstration: Demonstration): string {
  return [
    "Ceilo minichain demonstration",
    "=============================",
    "",
    ...formatOverview(demonstration.overview),
    "",
    ...formatBalanceProof(demonstration.balanceProof),
    "",
    ...formatScenarios(demonstration.scenarios),
    "",
    ...formatSummary(demonstration.scenarios),
  ].join("\n");
}

if (import.meta.main) {
  console.log(formatDemonstration(runDemonstration()));
}
