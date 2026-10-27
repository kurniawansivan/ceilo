import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type DoubleSpendParameters, PAYMENT_AMOUNT, simulateDoubleSpend } from "./attack.ts";

const OVERWHELMING: DoubleSpendParameters = {
  honestAttemptsPerRound: 5,
  attackerAttemptsPerRound: 100,
  confirmationsRequired: 2,
  maximumRounds: 400,
};

const POWERLESS: DoubleSpendParameters = {
  ...OVERWHELMING,
  attackerAttemptsPerRound: 0,
  maximumRounds: 100,
};

describe("an attacker with far more hash power than everyone else", () => {
  const report = simulateDoubleSpend(OVERWHELMING);

  test("takes back a payment the merchant had already accepted", () => {
    assert.equal(report.succeeded, true);
    assert.equal(report.merchantBalanceWhenShipped, PAYMENT_AMOUNT);
    assert.equal(report.merchantBalanceAtEnd, 0n);
    assert.equal(report.attackerSavingsAtEnd, PAYMENT_AMOUNT);
  });

  test("keeps the chain secret until the merchant has shipped, then publishes a chain with more work", () => {
    assert.ok(report.confirmedAtRound !== undefined);
    assert.ok(report.releasedAtRound !== undefined);
    assert.ok(report.releasedAtRound >= report.confirmedAtRound);
    assert.ok(report.honestHeightAtRelease !== undefined);
    assert.ok(report.attackerHeightAtRelease !== undefined);
    assert.ok(report.attackerHeightAtRelease > report.honestHeightAtRelease);
  });

  test("leaves every honest node on the attacker's chain", () => {
    assert.equal(report.honestNodesAgree, true);
  });

  test("owns more than nine tenths of all the hashing", () => {
    assert.equal(report.attackerShare, 100 / 110);
  });

  test("stops at the round it published", () => {
    assert.equal(report.rounds, report.releasedAtRound);
  });
});

describe("an attacker with no hash power", () => {
  const report = simulateDoubleSpend(POWERLESS);

  test("cannot reverse the payment, so the merchant keeps the money", () => {
    assert.equal(report.succeeded, false);
    assert.equal(report.merchantBalanceAtEnd, PAYMENT_AMOUNT);
    assert.equal(report.attackerSavingsAtEnd, 0n);
  });

  test("never publishes anything, and the scenario runs to its last round", () => {
    assert.equal(report.releasedAtRound, undefined);
    assert.equal(report.honestHeightAtRelease, undefined);
    assert.equal(report.attackerHeightAtRelease, undefined);
    assert.equal(report.rounds, POWERLESS.maximumRounds);
  });

  test("has no share of the hashing, and the merchant still shipped on honest confirmations", () => {
    assert.equal(report.attackerShare, 0);
    assert.ok(report.confirmedAtRound !== undefined);
    assert.equal(report.merchantBalanceWhenShipped, PAYMENT_AMOUNT);
    assert.equal(report.honestNodesAgree, true);
  });
});

describe("how long the merchant waits", () => {
  test("ships later when it asks for more confirmations", () => {
    const reports = [1, 2, 3].map((confirmationsRequired) =>
      simulateDoubleSpend({ ...POWERLESS, confirmationsRequired }),
    );
    const [one, two, three] = reports.map((report) => report.confirmedAtRound);
    assert.ok(one !== undefined && two !== undefined && three !== undefined);
    assert.ok(one < two && two < three);
  });

  test("ships as soon as the payment has exactly the confirmations it asked for, its own block counting as one", () => {
    for (const confirmationsRequired of [1, 2, 3]) {
      const report = simulateDoubleSpend({ ...POWERLESS, confirmationsRequired });
      assert.equal(report.confirmationsWhenShipped, confirmationsRequired);
    }
  });

  test("counts the block that holds the payment as the first confirmation", () => {
    for (const confirmationsRequired of [1, 2, 3]) {
      const report = simulateDoubleSpend({ ...OVERWHELMING, confirmationsRequired });
      assert.equal(report.honestHeightAtRelease, BigInt(confirmationsRequired));
    }
  });

  test("never ships when the scenario ends before enough blocks exist", () => {
    const report = simulateDoubleSpend({
      ...POWERLESS,
      confirmationsRequired: 50,
      maximumRounds: 5,
    });
    assert.equal(report.confirmedAtRound, undefined);
    assert.equal(report.confirmationsWhenShipped, undefined);
    assert.equal(report.merchantBalanceWhenShipped, undefined);
    assert.equal(report.succeeded, false);
  });

  test("shipping on the same round the attacker is ready makes the attacker publish that round", () => {
    const report = simulateDoubleSpend({ ...OVERWHELMING, confirmationsRequired: 1 });
    assert.equal(report.releasedAtRound, report.confirmedAtRound);
  });
});

describe("the outcome whatever the share", () => {
  for (const attackerAttemptsPerRound of [0, 3, 10, 30, 100, 400]) {
    test(`tells one consistent story with ${attackerAttemptsPerRound} attempts a round`, () => {
      const report = simulateDoubleSpend({
        ...OVERWHELMING,
        attackerAttemptsPerRound,
        maximumRounds: 150,
      });

      assert.equal(report.honestNodesAgree, true);
      assert.equal(
        report.succeeded,
        report.merchantBalanceAtEnd === 0n && report.confirmedAtRound !== undefined,
      );
      if (report.succeeded) {
        assert.equal(report.attackerSavingsAtEnd, PAYMENT_AMOUNT);
        assert.ok(report.releasedAtRound !== undefined && report.confirmedAtRound !== undefined);
        assert.ok(report.releasedAtRound >= report.confirmedAtRound);
      } else {
        assert.equal(report.attackerSavingsAtEnd, 0n);
        assert.equal(report.releasedAtRound, undefined);
      }
    });
  }

  test("is the same every time, because hashing is deterministic", () => {
    assert.deepEqual(simulateDoubleSpend(OVERWHELMING), simulateDoubleSpend(OVERWHELMING));
  });
});

describe("a scenario that makes no sense", () => {
  test("is refused", () => {
    const refused: Partial<DoubleSpendParameters>[] = [
      { honestAttemptsPerRound: 0 },
      { honestAttemptsPerRound: 1.5 },
      { attackerAttemptsPerRound: -1 },
      { attackerAttemptsPerRound: 2.5 },
      { confirmationsRequired: 0 },
      { confirmationsRequired: 1.5 },
      { maximumRounds: 0 },
      { maximumRounds: 3.5 },
    ];
    for (const change of refused) {
      assert.throws(() => simulateDoubleSpend({ ...OVERWHELMING, ...change }), RangeError);
    }
  });
});
