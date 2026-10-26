import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type Encodable, encode } from "./encoding.ts";

/** Builds a byte array from plain numbers. */
const byteArrayOf = (...values: number[]): Uint8Array => Uint8Array.from(values);

/** Renders bytes as hexadecimal so they can be compared as set members. */
const toHexadecimalText = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

describe("encode", () => {
  test("is deterministic", () => {
    const value: Encodable = ["a", 1n, byteArrayOf(1, 2, 3), [2n]];
    assert.deepEqual(encode(value), encode(value));
  });

  describe("exact layout", () => {
    test("bytes: tag 0x01, 32-bit length, payload", () => {
      assert.deepEqual(encode(byteArrayOf(0xaa, 0xbb)), byteArrayOf(0x01, 0, 0, 0, 2, 0xaa, 0xbb));
    });

    test("string: tag 0x03, 32-bit length, UTF-8", () => {
      assert.deepEqual(encode("é"), byteArrayOf(0x03, 0, 0, 0, 2, 0xc3, 0xa9));
    });

    test("unsigned integer: tag 0x02, 32-bit length, minimal big-endian", () => {
      assert.deepEqual(encode(0n), byteArrayOf(0x02, 0, 0, 0, 0));
      assert.deepEqual(encode(255n), byteArrayOf(0x02, 0, 0, 0, 1, 0xff));
      assert.deepEqual(encode(256n), byteArrayOf(0x02, 0, 0, 0, 2, 0x01, 0x00));
    });

    test("list: tag 0x04, 32-bit item count, items", () => {
      assert.deepEqual(
        encode(["a", 1n]),
        byteArrayOf(0x04, 0, 0, 0, 2, 0x03, 0, 0, 0, 1, 0x61, 0x02, 0, 0, 0, 1, 0x01),
      );
    });
  });

  describe("is unambiguous", () => {
    test("different field boundaries give different bytes", () => {
      assert.notDeepEqual(encode(["ab", "c"]), encode(["a", "bc"]));
    });

    test("payload bytes that look like a tag cannot fake a field boundary", () => {
      // Without length prefixes both lists would flatten to 03 78 03 79 03 7a.
      assert.notDeepEqual(encode(["x\u0003y", "z"]), encode(["x", "y\u0003z"]));
    });

    test("different nesting gives different bytes", () => {
      assert.notDeepEqual(encode([[1n], [2n]]), encode([[1n, 2n]]));
    });

    test("different types with the same payload give different bytes", () => {
      const encodings = [encode(1n), encode(byteArrayOf(1)), encode("\u0001"), encode([1n])];
      const distinctEncodings = new Set(encodings.map(toHexadecimalText));
      assert.equal(distinctEncodings.size, encodings.length);
    });

    test("a diverse sample never collides", () => {
      const sampleValues: Encodable[] = [
        0n,
        1n,
        255n,
        256n,
        2n ** 64n,
        "",
        "0",
        "\u0000",
        byteArrayOf(),
        byteArrayOf(0),
        [],
        [[]],
        [[], []],
        [0n],
        [0n, 0n],
        ["", ""],
        [byteArrayOf(), byteArrayOf()],
      ];
      const distinctEncodings = new Set(
        sampleValues.map((sampleValue) => toHexadecimalText(encode(sampleValue))),
      );
      assert.equal(distinctEncodings.size, sampleValues.length);
    });
  });

  describe("rejects values that have no single canonical encoding", () => {
    test("negative integers", () => {
      assert.throws(() => encode(-1n), RangeError);
    });

    test("strings with lone surrogates, which UTF-8 would silently rewrite", () => {
      assert.throws(() => encode("\ud800"), RangeError);
    });

    test("JavaScript numbers, whose float semantics are ambiguous", () => {
      assert.throws(() => encode(1 as unknown as Encodable), TypeError);
    });

    test("undefined, null and plain objects", () => {
      assert.throws(() => encode(undefined as unknown as Encodable), TypeError);
      assert.throws(() => encode(null as unknown as Encodable), TypeError);
      assert.throws(() => encode({} as unknown as Encodable), TypeError);
    });
  });
});
