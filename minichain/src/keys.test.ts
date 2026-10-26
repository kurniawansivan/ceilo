import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { toHexadecimal } from "./hash.ts";
import { ADDRESS_LENGTH, deriveAddress, derivePublicKey, generatePrivateKey } from "./keys.ts";
import { privateKeyWithValue } from "./testing.ts";

// Published Ethereum addresses for private keys 1 and 2.
const ADDRESS_OF_PRIVATE_KEY_ONE = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const ADDRESS_OF_PRIVATE_KEY_TWO = "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf";

describe("generatePrivateKey", () => {
  test("returns 32 bytes", () => {
    assert.equal(generatePrivateKey().length, 32);
  });

  test("returns a different key every time", () => {
    assert.notDeepEqual(generatePrivateKey(), generatePrivateKey());
  });

  test("returns a key that derives a public key", () => {
    assert.equal(derivePublicKey(generatePrivateKey()).length, 65);
  });
});

describe("derivePublicKey", () => {
  test("returns the 65-byte uncompressed form: 0x04, then x and y", () => {
    const publicKey = derivePublicKey(privateKeyWithValue(1));
    assert.equal(publicKey.length, 65);
    assert.equal(publicKey[0], 0x04);
  });

  test("is deterministic", () => {
    assert.deepEqual(derivePublicKey(privateKeyWithValue(7)), derivePublicKey(privateKeyWithValue(7)));
  });

  test("rejects the zero key, which is not on the curve's valid range", () => {
    assert.throws(() => derivePublicKey(new Uint8Array(32)));
  });

  test("rejects a private key of the wrong length", () => {
    assert.throws(() => derivePublicKey(new Uint8Array(31).fill(1)));
  });
});

describe("deriveAddress", () => {
  test("matches the published Ethereum addresses", () => {
    assert.equal(
      toHexadecimal(deriveAddress(derivePublicKey(privateKeyWithValue(1)))),
      ADDRESS_OF_PRIVATE_KEY_ONE,
    );
    assert.equal(
      toHexadecimal(deriveAddress(derivePublicKey(privateKeyWithValue(2)))),
      ADDRESS_OF_PRIVATE_KEY_TWO,
    );
  });

  test("is ADDRESS_LENGTH bytes", () => {
    assert.equal(ADDRESS_LENGTH, 20);
    assert.equal(deriveAddress(derivePublicKey(privateKeyWithValue(1))).length, ADDRESS_LENGTH);
  });

  test("gives different keys different addresses", () => {
    assert.notDeepEqual(
      deriveAddress(derivePublicKey(privateKeyWithValue(1))),
      deriveAddress(derivePublicKey(privateKeyWithValue(2))),
    );
  });

  test("rejects a compressed public key", () => {
    const compressedPublicKey = derivePublicKey(privateKeyWithValue(1)).slice(0, 33);
    assert.throws(() => deriveAddress(compressedPublicKey), RangeError);
  });

  test("rejects a public key without the 0x04 prefix", () => {
    const publicKey = derivePublicKey(privateKeyWithValue(1));
    publicKey[0] = 0x02;
    assert.throws(() => deriveAddress(publicKey), RangeError);
  });
});
