/** Byte helpers shared by the VLESS framing and HTTP-over-tunnel modules. */

export const EMPTY_BYTES: Uint8Array = new Uint8Array(0);

/** Concatenate byte arrays into a single newly allocated array. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
