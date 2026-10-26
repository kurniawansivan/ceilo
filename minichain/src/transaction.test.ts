import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { numberToBytesBE } from "@noble/curves/utils.js";

import { hashOf } from "./hash.ts";
import { type Address, deriveAddress, derivePublicKey } from "./keys.ts";
import { privateKeyWithValue } from "./testing.ts";
import {
  hashSignedTransaction,
  hashUnsignedTransaction,
  recoverSender,
  SIGNATURE_LENGTH,
  type SignedTransaction,
  signTransaction,
  type UnsignedTransaction,
} from "./transaction.ts";

const senderPrivateKey = privateKeyWithValue(1);
const senderAddress = deriveAddress(derivePublicKey(senderPrivateKey));
const recipientAddress = deriveAddress(derivePublicKey(privateKeyWithValue(2)));

/** One altered field per entry, each of which must change the transaction's meaning. */
const FIELD_ALTERATIONS: Record<string, Partial<UnsignedTransaction>> = {
  "chain identifier": { chainIdentifier: 1338n },
  nonce: { nonce: 1n },
  recipient: { recipient: senderAddress },
  amount: { amount: 101n },
  fee: { fee: 2n },
};

/** Builds a valid unsigned transaction, letting a test override individual fields. */
const createUnsignedTransaction = (
  overrides: Partial<UnsignedTransaction> = {},
): UnsignedTransaction => ({
  chainIdentifier: 1337n,
  nonce: 0n,
  recipient: recipientAddress,
  amount: 100n,
  fee: 1n,
  ...overrides,
});

/** Recovers a sender, or returns undefined when the signature is rejected. */
const tryRecoverSender = (signedTransaction: SignedTransaction): Address | undefined => {
  try {
    return recoverSender(signedTransaction);
  } catch {
    return undefined;
  }
};

/** Builds a recoverable signature with recovery byte 0 from raw r and s values. */
const signatureFrom = (r: bigint, s: bigint): Uint8Array =>
  Uint8Array.from([0, ...numberToBytesBE(r, 32), ...numberToBytesBE(s, 32)]);

/** Builds the mathematically valid high-S twin of a low-S signature. */
const toHighSTwinSignature = (signature: Uint8Array): Uint8Array => {
  const parsedSignature = secp256k1.Signature.fromBytes(signature, "recovered");
  const curveOrder = secp256k1.Point.Fn.ORDER;
  return new secp256k1.Signature(
    parsedSignature.r,
    curveOrder - parsedSignature.s,
    (parsedSignature.recovery ?? 0) ^ 1,
  ).toBytes("recovered");
};

describe("signTransaction and recoverSender", () => {
  test("recover the address of whoever signed", () => {
    const signedTransaction = signTransaction(createUnsignedTransaction(), senderPrivateKey);
    assert.deepEqual(recoverSender(signedTransaction), senderAddress);
  });

  test("produce a SIGNATURE_LENGTH signature whose recovery byte is 0 or 1", () => {
    const { signature } = signTransaction(createUnsignedTransaction(), senderPrivateKey);
    assert.equal(SIGNATURE_LENGTH, 65);
    assert.equal(signature.length, SIGNATURE_LENGTH);
    assert.ok(signature[0] === 0 || signature[0] === 1);
  });

  test("sign deterministically: the same transaction and key give the same signature", () => {
    const first = signTransaction(createUnsignedTransaction(), senderPrivateKey);
    const second = signTransaction(createUnsignedTransaction(), senderPrivateKey);
    assert.deepEqual(first.signature, second.signature);
  });

  test("keep the signed fields unchanged", () => {
    const unsignedTransaction = createUnsignedTransaction();
    const signedTransaction = signTransaction(unsignedTransaction, senderPrivateKey);
    assert.deepEqual(
      { ...signedTransaction, signature: undefined },
      { ...unsignedTransaction, signature: undefined },
    );
  });

  for (const [fieldName, alteration] of Object.entries(FIELD_ALTERATIONS)) {
    test(`changing the ${fieldName} after signing no longer recovers the sender`, () => {
      const signedTransaction = signTransaction(createUnsignedTransaction(), senderPrivateKey);
      const alteredTransaction: SignedTransaction = { ...signedTransaction, ...alteration };
      assert.notDeepEqual(tryRecoverSender(alteredTransaction), senderAddress);
    });
  }

  test("a signature for one chain cannot be replayed on another", () => {
    const signedOnChainOne = signTransaction(
      createUnsignedTransaction({ chainIdentifier: 1n }),
      senderPrivateKey,
    );
    const replayedOnChainTwo: SignedTransaction = { ...signedOnChainOne, chainIdentifier: 2n };
    assert.notDeepEqual(tryRecoverSender(replayedOnChainTwo), senderAddress);
  });
});

describe("recoverSender rejects", () => {
  test("the high-S twin of a valid signature, which would otherwise be a second valid signature", () => {
    const signedTransaction = signTransaction(createUnsignedTransaction(), senderPrivateKey);
    const twinSignature = toHighSTwinSignature(signedTransaction.signature);

    // The attack is real: the library still recovers the same key from the twin.
    const recoveredPublicKey = secp256k1.recoverPublicKey(
      twinSignature,
      hashUnsignedTransaction(signedTransaction),
      {
        prehash: false,
      },
    );
    assert.deepEqual(
      deriveAddress(secp256k1.Point.fromBytes(recoveredPublicKey).toBytes(false)),
      senderAddress,
    );

    assert.throws(
      () => recoverSender({ ...signedTransaction, signature: twinSignature }),
      RangeError,
    );
  });

  test("a signature of the wrong length", () => {
    const signedTransaction = signTransaction(createUnsignedTransaction(), senderPrivateKey);
    assert.throws(() =>
      recoverSender({ ...signedTransaction, signature: signedTransaction.signature.slice(1) }),
    );
    assert.throws(() => recoverSender({ ...signedTransaction, signature: new Uint8Array(66) }));
  });

  test("a recovery byte other than 0 or 1", () => {
    const signedTransaction = signTransaction(createUnsignedTransaction(), senderPrivateKey);
    for (const invalidRecoveryByte of [2, 3, 255]) {
      const signature = Uint8Array.from(signedTransaction.signature);
      signature[0] = invalidRecoveryByte;
      assert.throws(() => recoverSender({ ...signedTransaction, signature }), RangeError);
    }
  });

  test("a signature whose r or s is out of range, as a RangeError and not a library error", () => {
    const signedTransaction = signTransaction(createUnsignedTransaction(), senderPrivateKey);
    const curveOrder = secp256k1.Point.Fn.ORDER;
    const outOfRangeSignatures: Record<string, Uint8Array> = {
      "all zero": new Uint8Array(SIGNATURE_LENGTH),
      "r equal to the curve order": signatureFrom(curveOrder, 1n),
      "s equal to the curve order": signatureFrom(1n, curveOrder),
      "every byte 0xff": Uint8Array.from([0, ...new Uint8Array(SIGNATURE_LENGTH - 1).fill(0xff)]),
    };

    for (const [description, signature] of Object.entries(outOfRangeSignatures)) {
      assert.throws(
        () => recoverSender({ ...signedTransaction, signature }),
        RangeError,
        description,
      );
    }
  });
});

describe("signTransaction rejects", () => {
  test("a recipient that is not ADDRESS_LENGTH bytes", () => {
    const unsignedTransaction = createUnsignedTransaction({ recipient: recipientAddress.slice(1) });
    assert.throws(() => signTransaction(unsignedTransaction, senderPrivateKey), RangeError);
  });

  test("negative amounts, fees, nonces and chain identifiers", () => {
    for (const negativeField of ["amount", "fee", "nonce", "chainIdentifier"] as const) {
      const unsignedTransaction = createUnsignedTransaction({ [negativeField]: -1n });
      assert.throws(
        () => signTransaction(unsignedTransaction, senderPrivateKey),
        RangeError,
        negativeField,
      );
    }
  });
});

describe("hashUnsignedTransaction", () => {
  test("hashes the domain tag followed by every field, in a fixed order", () => {
    assert.deepEqual(
      hashUnsignedTransaction(createUnsignedTransaction()),
      hashOf(["ceilo/transaction", 1337n, 0n, recipientAddress, 100n, 1n]),
    );
  });

  for (const [fieldName, alteration] of Object.entries(FIELD_ALTERATIONS)) {
    test(`changes when the ${fieldName} changes`, () => {
      assert.notDeepEqual(
        hashUnsignedTransaction(createUnsignedTransaction()),
        hashUnsignedTransaction(createUnsignedTransaction(alteration)),
      );
    });
  }
});

describe("hashSignedTransaction", () => {
  test("hashes its own domain tag, the fields, then the signature", () => {
    const signedTransaction = signTransaction(createUnsignedTransaction(), senderPrivateKey);
    assert.deepEqual(
      hashSignedTransaction(signedTransaction),
      hashOf([
        "ceilo/signed-transaction",
        1337n,
        0n,
        recipientAddress,
        100n,
        1n,
        signedTransaction.signature,
      ]),
    );
  });

  test("differs from the hash that was signed", () => {
    const signedTransaction = signTransaction(createUnsignedTransaction(), senderPrivateKey);
    assert.notDeepEqual(
      hashSignedTransaction(signedTransaction),
      hashUnsignedTransaction(signedTransaction),
    );
  });

  test("covers the signature, so a high-S twin would get a different identifier", () => {
    const signedTransaction = signTransaction(createUnsignedTransaction(), senderPrivateKey);
    const twinTransaction = {
      ...signedTransaction,
      signature: toHighSTwinSignature(signedTransaction.signature),
    };
    assert.notDeepEqual(
      hashSignedTransaction(signedTransaction),
      hashSignedTransaction(twinTransaction),
    );
  });
});
