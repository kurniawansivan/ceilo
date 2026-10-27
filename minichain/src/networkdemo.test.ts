import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { PAYMENT_AMOUNT } from "./attack.ts";
import { formatNetworkDemonstration, runNetworkDemonstration } from "./networkdemo.ts";

describe("the partition story", () => {
  const { partition } = runNetworkDemonstration();

  test("has each half of the network mine on its own", () => {
    assert.equal(partition.northBlocksMined, 2);
    assert.equal(partition.southBlocksMined, 1);
  });

  test("lets each half agree inside itself while the two halves disagree", () => {
    assert.equal(partition.halvesAgreeInside, true);
    assert.equal(partition.halvesAgreeWithEachOther, false);
  });

  test("puts every node on the chain with more work once the halves are joined", () => {
    assert.equal(partition.agreedAfterJoining, true);
    assert.equal(partition.finalHeight, 2n);
  });

  test("abandons the shorter branch and returns the payment it held to the pool", () => {
    assert.equal(partition.abandonedBlockCount, 1);
    assert.equal(partition.paymentBackInPool, true);
    assert.equal(partition.bobBalanceOnSouthBeforeJoining, 550n);
    assert.equal(partition.bobBalanceOnSouthAfterJoining, 500n);
  });
});

describe("the 51% attack table", () => {
  const { doubleSpends } = runNetworkDemonstration();

  test("tries five strengths of attacker, weakest first", () => {
    assert.deepEqual(
      doubleSpends.map((row) => row.attackerAttemptsPerRound),
      [0, 3, 10, 30, 100],
    );
    const shares = doubleSpends.map((row) => row.report.attackerShare);
    assert.deepEqual(
      shares,
      [...shares].sort((first, second) => first - second),
    );
  });

  test("shows the payment surviving until the attacker has well over half of the hashing", () => {
    assert.deepEqual(
      doubleSpends.map((row) => row.report.succeeded),
      [false, false, false, true, true],
    );
  });

  test("shows the merchant's money moving to the attacker's savings on every success", () => {
    for (const { report } of doubleSpends) {
      if (report.succeeded) {
        assert.equal(report.merchantBalanceWhenShipped, PAYMENT_AMOUNT);
        assert.equal(report.merchantBalanceAtEnd, 0n);
        assert.equal(report.attackerSavingsAtEnd, PAYMENT_AMOUNT);
      } else {
        assert.equal(report.merchantBalanceAtEnd, PAYMENT_AMOUNT);
        assert.equal(report.attackerSavingsAtEnd, 0n);
      }
    }
  });
});

describe("a repeat run", () => {
  test("gives the same demonstration, because hashing is deterministic", () => {
    assert.deepEqual(runNetworkDemonstration(), runNetworkDemonstration());
  });
});

describe("formatNetworkDemonstration", () => {
  const demonstration = runNetworkDemonstration();
  const text = formatNetworkDemonstration(demonstration).join("\n");

  test("titles both sections, numbered to follow the attacks", () => {
    assert.ok(text.includes("4. Consensus: nodes that split and agree again"));
    assert.ok(text.includes("5. A majority of hash power can undo a payment"));
  });

  test("tells the partition story in numbers", () => {
    assert.ok(text.includes("north mined 2 blocks, south mined 1"));
    assert.ok(text.includes("550 before, 500 after"));
    assert.ok(text.includes("the payment is back in the pool"));
  });

  test("lists every attacker strength with its share of the hashing and the result", () => {
    for (const { report } of demonstration.doubleSpends) {
      assert.ok(
        text.includes(`${Math.round(report.attackerShare * 100)}%`),
        `missing share ${report.attackerShare}`,
      );
    }
    assert.ok(text.includes("the payment stands"));
    assert.ok(text.includes("reversed in round"));
  });

  test("describes each attacker's result with its own numbers", () => {
    for (const { report } of demonstration.doubleSpends) {
      if (report.succeeded) {
        assert.ok(
          text.includes(
            `reversed in round ${report.releasedAtRound}: secret chain ${report.attackerHeightAtRelease} blocks against ${report.honestHeightAtRelease}`,
          ),
        );
      } else {
        assert.ok(text.includes(`never had more work in ${report.rounds} rounds`));
      }
    }
  });

  test("answers each question of the partition story in the right place", () => {
    assert.ok(
      text.includes("each half agrees inside itself: yes; the halves agree with each other: no"),
    );
    assert.ok(text.includes("all four follow the same chain (height 2): yes"));
    assert.ok(
      text.includes(
        "blocks abandoned by the half with less work: 1; the payment is back in the pool: yes",
      ),
    );
  });

  test("names the merchant's patience and separates the two sections with a blank line", () => {
    assert.ok(text.includes("the merchant ships after 2 confirmations"));
    assert.ok(text.includes("500 after\n\n5. A majority"));
  });

  test("states the lesson about a majority of hash power", () => {
    assert.ok(text.includes("majority"));
  });
});
