import { secp256k1 } from "@noble/curves/secp256k1.js";

import { type Encodable } from "./encoding.ts";
import { type Hash, hashOf } from "./hash.ts";
import { ADDRESS_LENGTH, type Address, deriveAddress, type PrivateKey } from "./keys.ts";

/** Number of bytes in a recoverable signature: one recovery byte, then r and s. */
export const SIGNATURE_LENGTH = 65;

const UNSIGNED_TRANSACTION_DOMAIN = "ceilo/transaction";
const SIGNED_TRANSACTION_DOMAIN = "ceilo/signed-transaction";

/** A transfer of the native coin, before its sender has signed it. */
export type UnsignedTransaction = {
  readonly chainIdentifier: bigint;
  readonly nonce: bigint;
  readonly recipient: Address;
  readonly amount: bigint;
  readonly fee: bigint;
};

/** A transaction plus the sender's signature; the sender itself is recovered, never stored. */
export type SignedTransaction = UnsignedTransaction & { readonly signature: Uint8Array };

/** Lists the fields in hashing order, rejecting a recipient of the wrong length. */
function listFieldsInHashingOrder(unsignedTransaction: UnsignedTransaction): Encodable[] {
  if (unsignedTransaction.recipient.length !== ADDRESS_LENGTH) {
    throw new RangeError(`recipient must be ${ADDRESS_LENGTH} bytes`);
  }
  return [
    unsignedTransaction.chainIdentifier,
    unsignedTransaction.nonce,
    unsignedTransaction.recipient,
    unsignedTransaction.amount,
    unsignedTransaction.fee,
  ];
}

/** Hashes the fields under a domain tag; this is the message the sender signs. */
export function hashUnsignedTransaction(unsignedTransaction: UnsignedTransaction): Hash {
  return hashOf([UNSIGNED_TRANSACTION_DOMAIN, ...listFieldsInHashingOrder(unsignedTransaction)]);
}

/** Hashes the fields and the signature under their own domain tag; this identifies the transaction. */
export function hashSignedTransaction(signedTransaction: SignedTransaction): Hash {
  return hashOf([
    SIGNED_TRANSACTION_DOMAIN,
    ...listFieldsInHashingOrder(signedTransaction),
    signedTransaction.signature,
  ]);
}

/** Signs a transaction with a recoverable, low-S signature over its keccak-256 hash. */
export function signTransaction(unsignedTransaction: UnsignedTransaction, privateKey: PrivateKey): SignedTransaction {
  const signature = secp256k1.sign(hashUnsignedTransaction(unsignedTransaction), privateKey, {
    prehash: false,
    format: "recovered",
  });
  return { ...unsignedTransaction, signature };
}

/** Recovers the sender's address from the signature, throwing if the signature is malformed or malleable. */
export function recoverSender(signedTransaction: SignedTransaction): Address {
  const { signature } = signedTransaction;
  if (signature.length !== SIGNATURE_LENGTH) {
    throw new RangeError(`signature must be ${SIGNATURE_LENGTH} bytes`);
  }
  if (signature[0] !== 0 && signature[0] !== 1) {
    throw new RangeError("recovery byte must be 0 or 1");
  }
  // Recovery accepts both the low-S and high-S form of a signature, so one transaction would get two valid signatures.
  if (secp256k1.Signature.fromBytes(signature, "recovered").hasHighS()) {
    throw new RangeError("signature has a high S value and is malleable");
  }
  const compressedPublicKey = secp256k1.recoverPublicKey(signature, hashUnsignedTransaction(signedTransaction), {
    prehash: false,
  });
  return deriveAddress(secp256k1.Point.fromBytes(compressedPublicKey).toBytes(false));
}
