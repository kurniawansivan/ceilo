import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatDemonstration, runDemonstration } from "./demo.ts";

/** What each attack must be detected by, and why; the demonstration may not drift from this. */
const EXPECTED_OUTCOMES: Record<string, { detectedBy: string; reason: string }> = {
  "edit-amount": {
    detectedBy: "chain structure",
    reason: "transactions-root-mismatch at block 2",
  },
  "edit-amount-and-header": {
    detectedBy: "chain structure",
    reason: "previous-hash-mismatch at block 3",
  },
  "forge-state-root": { detectedBy: "state replay", reason: "state-root-mismatch at block 2" },
  "redirect-fees": { detectedBy: "state replay", reason: "state-root-mismatch at block 3" },
  "tamper-after-signing": { detectedBy: "transaction rules", reason: "insufficient-balance" },
  "replay-transaction": { detectedBy: "transaction rules", reason: "nonce-mismatch" },
  overspend: { detectedBy: "transaction rules", reason: "insufficient-balance" },
  "free-transaction": { detectedBy: "transaction rules", reason: "fee-too-low" },
  "wrong-chain": { detectedBy: "transaction rules", reason: "wrong-chain" },
  "invalid-signature": { detectedBy: "transaction rules", reason: "invalid-signature" },
  "rewrite-history": {
    detectedBy: "not detected",
    reason: "valid alternative history, which only consensus can reject",
  },
};

describe("runDemonstration", () => {
  const demonstration = runDemonstration();

  test("builds an honest chain of five blocks that replays cleanly", () => {
    assert.equal(demonstration.overview.blocks.length, 5);
    assert.equal(demonstration.overview.honestChainReplays, true);
  });

  test("keeps the total supply at its genesis value", () => {
    assert.equal(demonstration.overview.initialSupply, 1_500n);
    assert.equal(demonstration.overview.finalSupply, 1_500n);
  });

  test("lists every participant's final balance and nonce", () => {
    const names = demonstration.overview.participants.map((participant) => participant.name);
    assert.deepEqual(names, ["Alice", "Bob", "Carol", "Mallory"]);
    assert.equal(demonstration.overview.participants[0]?.balance, 792n);
    assert.equal(demonstration.overview.participants[0]?.nonce, 4n);
  });

  test("runs exactly the expected scenarios", () => {
    const identifiers = demonstration.scenarios.map((scenario) => scenario.id).sort();
    assert.deepEqual(identifiers, Object.keys(EXPECTED_OUTCOMES).sort());
  });

  for (const [identifier, expected] of Object.entries(EXPECTED_OUTCOMES)) {
    test(`${identifier}: ${expected.detectedBy}, with ${expected.reason}`, () => {
      const scenario = demonstration.scenarios.find((candidate) => candidate.id === identifier);
      assert.ok(scenario, `no scenario named ${identifier}`);
      assert.equal(scenario.detectedBy, expected.detectedBy);
      assert.equal(scenario.reason, expected.reason);
    });
  }

  test("gives every scenario a title, a description of the attack and a detail", () => {
    for (const scenario of demonstration.scenarios) {
      assert.ok(scenario.title.length > 0, scenario.id);
      assert.ok(scenario.attack.length > 0, scenario.id);
      assert.ok(scenario.detail.length > 0, scenario.id);
    }
  });

  test("rewrites history into a tip that really is different from the honest one", () => {
    const scenario = demonstration.scenarios.find(
      (candidate) => candidate.id === "rewrite-history",
    );
    assert.ok(scenario);

    const match = /tip (0x[0-9a-f]+\.\.\.) replaces (0x[0-9a-f]+\.\.\.)/.exec(scenario.detail);
    assert.ok(match, `detail does not name both tips: ${scenario.detail}`);
    assert.notEqual(match[1], match[2]);
  });

  test("proves a balance from a block header alone, and rejects an inflated claim", () => {
    const { balanceProof } = demonstration;
    assert.equal(balanceProof.participantName, "Bob");
    assert.equal(balanceProof.balance, 656n);
    assert.ok(balanceProof.proofSteps >= 1);
    assert.equal(balanceProof.genuineClaimAccepted, true);
    assert.equal(balanceProof.inflatedClaimAccepted, false);
  });

  test("carries the network demonstration: a split that heals and a 51% attack", () => {
    assert.equal(demonstration.network.partition.agreedAfterJoining, true);
    assert.equal(demonstration.network.doubleSpends.length, 5);
  });

  test("is deterministic: two runs give the same text", () => {
    assert.equal(formatDemonstration(runDemonstration()), formatDemonstration(runDemonstration()));
  });
});

describe("formatDemonstration", () => {
  const demonstration = runDemonstration();
  const text = formatDemonstration(demonstration);

  test("mentions every scenario by title", () => {
    for (const scenario of demonstration.scenarios) {
      assert.ok(text.includes(scenario.title), `missing: ${scenario.title}`);
    }
  });

  test("shows the layers an attack can be detected by", () => {
    for (const layer of ["chain structure", "transaction rules", "state replay", "not detected"]) {
      assert.ok(text.includes(layer), `missing layer: ${layer}`);
    }
  });

  test("numbers its sections one to six, in order", () => {
    const headings = text.split("\n").filter((line) => /^[0-9]\. /.test(line));
    assert.deepEqual(
      headings.map((heading) => heading.slice(0, 2)),
      ["1.", "2.", "3.", "4.", "5.", "6."],
    );
  });

  test("includes the network sections before the summary", () => {
    assert.ok(text.indexOf("4. Consensus") < text.indexOf("5. A majority"));
    assert.ok(text.indexOf("5. A majority") < text.indexOf("6. Summary"));
  });

  test("states the lesson: tamper-evident, not tamper-proof", () => {
    assert.ok(text.includes("tamper-evident"));
    assert.ok(text.includes("tamper-proof"));
  });
});
