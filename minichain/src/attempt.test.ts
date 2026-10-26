import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { tryCompute } from "./attempt.ts";

/** An error type that tryCompute has no reason to treat as bad input. */
class UnrelatedError extends Error {}

describe("tryCompute", () => {
  test("returns what the computation returns", () => {
    assert.equal(
      tryCompute(() => "result"),
      "result",
    );
  });

  test("passes falsy results through instead of mistaking them for a rejection", () => {
    assert.equal(
      tryCompute(() => 0),
      0,
    );
    assert.equal(
      tryCompute(() => ""),
      "",
    );
    assert.equal(
      tryCompute(() => false),
      false,
    );
  });

  test("returns undefined when the computation rejects its input with a RangeError", () => {
    assert.equal(
      tryCompute(() => {
        throw new RangeError("out of range");
      }),
      undefined,
    );
  });

  test("returns undefined when the computation rejects its input with a TypeError", () => {
    assert.equal(
      tryCompute(() => {
        throw new TypeError("wrong type");
      }),
      undefined,
    );
  });

  test("lets every other error through, because it is a bug and not bad input", () => {
    assert.throws(
      () =>
        tryCompute(() => {
          throw new Error("unexpected failure");
        }),
      /unexpected failure/,
    );
    assert.throws(
      () =>
        tryCompute(() => {
          throw new UnrelatedError("another failure");
        }),
      UnrelatedError,
    );
  });
});
