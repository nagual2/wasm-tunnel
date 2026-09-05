/** RFC 4122 UUID helpers for VLESS user IDs. */

const DASHED_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const PLAIN_UUID_RE = /^[0-9a-fA-F]{32}$/;

/** Parse a dashed (or plain 32-hex) UUID string into 16 raw bytes. */
export function parseUUID(value: string): Uint8Array {
  const raw = value.trim();
  let hex: string;
  if (DASHED_UUID_RE.test(raw)) {
    hex = raw.replace(/-/g, "").toLowerCase();
  } else if (PLAIN_UUID_RE.test(raw)) {
    hex = raw.toLowerCase();
  } else {
    throw new Error(`invalid UUID: ${JSON.stringify(value)}`);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Serialize 16 raw bytes into the canonical dashed lowercase UUID form. */
export function stringifyUUID(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new Error(`UUID must be exactly 16 bytes, got ${bytes.length}`);
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
