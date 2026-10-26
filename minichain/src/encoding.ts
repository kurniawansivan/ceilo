import { concatBytes, hexToBytes } from "@noble/hashes/utils.js";

/** Values `encode` accepts; numbers, null, undefined and plain objects have no single byte form. */
export type Encodable = Uint8Array | bigint | string | readonly Encodable[];

const TYPE_TAG_BYTES = 0x01;
const TYPE_TAG_UNSIGNED_INTEGER = 0x02;
const TYPE_TAG_STRING = 0x03;
const TYPE_TAG_LIST = 0x04;

const LENGTH_PREFIX_BYTE_COUNT = 4;
const MAXIMUM_ENCODABLE_LENGTH = 0xffff_ffff;

/** Writes a length as a 4-byte big-endian number. */
function encodeLengthPrefix(length: number): Uint8Array {
  if (length > MAXIMUM_ENCODABLE_LENGTH) {
    throw new RangeError(`length ${length} does not fit in ${LENGTH_PREFIX_BYTE_COUNT} bytes`);
  }
  const lengthPrefix = new Uint8Array(LENGTH_PREFIX_BYTE_COUNT);
  new DataView(lengthPrefix.buffer).setUint32(0, length);
  return lengthPrefix;
}

/** Joins type tag, length prefix and payload so every item is self-delimiting. */
function encodeTaggedItem(typeTag: number, prefixedLength: number, payload: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(typeTag), encodeLengthPrefix(prefixedLength), payload);
}

/** Converts a non-negative integer to minimal big-endian bytes, with zero as no bytes. */
function unsignedIntegerToBytes(value: bigint): Uint8Array {
  if (value < 0n) {
    throw new RangeError("unsigned integers cannot be negative");
  }
  if (value === 0n) {
    return new Uint8Array(0);
  }
  const hexadecimal = value.toString(16);
  return hexToBytes(hexadecimal.length % 2 === 0 ? hexadecimal : `0${hexadecimal}`);
}

/** Names a value's type for error messages, telling null apart from objects. */
function describeType(value: unknown): string {
  return value === null ? "null" : typeof value;
}

/** Encodes a value to one canonical byte string: equal values match, different values never collide. */
export function encode(value: Encodable): Uint8Array {
  if (value instanceof Uint8Array) {
    return encodeTaggedItem(TYPE_TAG_BYTES, value.length, value);
  }
  if (typeof value === "bigint") {
    const payload = unsignedIntegerToBytes(value);
    return encodeTaggedItem(TYPE_TAG_UNSIGNED_INTEGER, payload.length, payload);
  }
  if (typeof value === "string") {
    // TextEncoder would replace a lone surrogate with U+FFFD, making two strings collide.
    if (!value.isWellFormed()) {
      throw new RangeError("string contains a lone surrogate");
    }
    const payload = new TextEncoder().encode(value);
    return encodeTaggedItem(TYPE_TAG_STRING, payload.length, payload);
  }
  if (Array.isArray(value)) {
    const encodedItems = value.map((item) => encode(item));
    return encodeTaggedItem(TYPE_TAG_LIST, encodedItems.length, concatBytes(...encodedItems));
  }
  throw new TypeError(`cannot encode a value of type ${describeType(value)}`);
}
