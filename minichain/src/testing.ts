/** Builds a 32-byte private key holding a small integer, for fixtures that need a known key. */
export function privateKeyWithValue(value: number): Uint8Array {
  const privateKey = new Uint8Array(32);
  privateKey[31] = value;
  return privateKey;
}
