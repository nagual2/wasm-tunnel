/**
 * Shadowsocks AEAD protocol module for WebSocket transport.
 *
 * Spec: "Shadowsocks AEAD ciphers" (SIP004):
 *   master key  = EVP_BytesToKey(password, keyLen)          [MD5-based]
 *   subkey      = HKDF-SHA1(master, salt, "ss-subkey")       [per direction]
 *   stream      = [salt(keyLen)] + chunks
 *   chunk       = [enc(len 2B BE)][16 tag][enc(payload)][16 tag]
 *   target      = [atype(1)][addr][port(2 BE)] in the first chunk payload
 *   server reply = server-salt + chunks; the first payload may or may not
 *                  echo the address header (Xray omits it) — see below.
 *
 * Platform notes:
 * - Only AES-GCM methods (aes-128-gcm / aes-256-gcm): they map to native
 *   SubtleCrypto. ChaCha20 variants would need a JS cipher — not planned.
 * - The node must expose SS over a WebSocket transport (Xray ss+ws inbound
 *   works). Raw-TCP SS sockets are unreachable from a browser page.
 * - EVP_BytesToKey needs MD5, which SubtleCrypto does not provide; a compact
 *   pure-JS MD5 lives below, confined to this module.
 */

import { concatBytes, EMPTY_BYTES } from "../bytes";
import { toWireAddress, ADDRESS_TYPE } from "../address";
import {
  makeWsTunnel,
  type ProtocolSession,
  type TargetAddress,
  type Tunnel,
  type WsTunnelOptions,
} from "../tunnel";

export type SsAeadMethod = "aes-128-gcm" | "aes-256-gcm";

const KEY_LENGTHS: Record<SsAeadMethod, number> = {
  "aes-128-gcm": 16,
  "aes-256-gcm": 32,
};
const TAG_LEN = 16;
const NONCE_LEN = 12;
const CHUNK_MAX = 0x3fff;
const INFO_SUBKEY = new TextEncoder().encode("ss-subkey");

/**
 * SS wire uses the SOCKS5 address-type numbering (domain 0x03, IPv6 0x04)
 * — unlike VLESS, which numbers domain 0x02 and IPv6 0x03.
 */
const SS_ADDRESS_TYPE = {
  IPV4: 0x01,
  DOMAIN: 0x03,
  IPV6: 0x04,
} as const;

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Classic MD5 (RFC 1321) — little-endian, 16-byte digest. */
export function md5(input: Uint8Array): Uint8Array {
  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const table = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  }

  const len = input.byteLength;
  const paddedLen = (((len + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLen);
  padded.set(input);
  padded[len] = 0x80;
  const bitLen = len * 8;
  // JS shifts are mod 32, so use division for the high length bytes.
  for (let i = 0; i < 8; i++) {
    padded[paddedLen - 8 + i] = Math.floor(bitLen / 2 ** (8 * i)) & 0xff;
  }

  let a0 = 0x67452301 | 0;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476 | 0;

  const view = new DataView(padded.buffer);
  for (let block = 0; block < paddedLen; block += 64) {
    const m = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
      m[i] = view.getUint32(block + i * 4, true);
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + table[i]! + m[g]!) | 0;
      a = d;
      d = c;
      c = b;
      const shifted = (sum << shifts[i]!) | (sum >>> (32 - shifts[i]!));
      b = (b + shifted) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0 >>> 0, true);
  outView.setUint32(4, b0 >>> 0, true);
  outView.setUint32(8, c0 >>> 0, true);
  outView.setUint32(12, d0 >>> 0, true);
  return out;
}

/** OpenSSL EVP_BytesToKey (MD5, no salt) — Shadowsocks master-key derivation. */
export function evpBytesToKey(password: string, keyLen: number): Uint8Array {
  const passwordBytes = new TextEncoder().encode(password);
  const out = new Uint8Array(keyLen);
  let filled = 0;
  let prev = EMPTY_BYTES;
  while (filled < keyLen) {
    prev = md5(concatBytes(prev, passwordBytes));
    const take = Math.min(prev.byteLength, keyLen - filled);
    out.set(prev.subarray(0, take), filled);
    filled += take;
  }
  return out;
}

async function deriveSubkey(master: Uint8Array, salt: Uint8Array, keyLen: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", toBuffer(master), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-1", salt: toBuffer(salt), info: toBuffer(INFO_SUBKEY) },
    base,
    keyLen * 8,
  );
  return new Uint8Array(bits);
}

/** AES-GCM session bound to a subkey with an incrementing 96-bit BE nonce. */
class AeadSession {
  private readonly nonce = new Uint8Array(NONCE_LEN);

  private constructor(private readonly key: CryptoKey) {}

  static async create(subkey: Uint8Array): Promise<AeadSession> {
    const key = await crypto.subtle.importKey("raw", toBuffer(subkey), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
    return new AeadSession(key);
  }

  async seal(plaintext: Uint8Array): Promise<Uint8Array> {
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toBuffer(this.nonce), tagLength: TAG_LEN * 8 },
      this.key,
      toBuffer(plaintext),
    );
    this.bumpNonce();
    return new Uint8Array(sealed);
  }

  async open(ciphertext: Uint8Array): Promise<Uint8Array> {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toBuffer(this.nonce), tagLength: TAG_LEN * 8 },
      this.key,
      toBuffer(ciphertext),
    );
    this.bumpNonce();
    return new Uint8Array(opened);
  }

  private bumpNonce(): void {
    // Xray/shadowsocks semantics: little-endian counter starting at zero
    // (Xray seeds the nonce with 0xFF×12 and pre-increments from byte 0).
    for (let i = 0; i < this.nonce.length; i++) {
      const value = (this.nonce[i] ?? 0) + 1;
      this.nonce[i] = value & 0xff;
      if (value < 0x100) return;
    }
    throw new Error("AEAD nonce space exhausted");
  }
}

/** Outbound encoder: random salt + chunked AEAD stream. */
export class SsAeadOutbound {
  private constructor(
    readonly salt: Uint8Array,
    private readonly session: AeadSession,
  ) {}

  static async create(masterKey: Uint8Array, keyLen: number): Promise<SsAeadOutbound> {
    const salt = new Uint8Array(keyLen);
    crypto.getRandomValues(salt);
    return new SsAeadOutbound(salt, await AeadSession.create(await deriveSubkey(masterKey, salt, keyLen)));
  }

  /** salt + chunks(prefix || data). */
  async encode(prefix: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    const stream = concatBytes(prefix, data);
    const parts: Uint8Array[] = [this.salt];
    let offset = 0;
    do {
      const take = Math.min(CHUNK_MAX, stream.byteLength - offset);
      const payload = stream.subarray(offset, offset + take);
      offset += take;
      const lenBuf = new Uint8Array(2);
      lenBuf[0] = (payload.byteLength >> 8) & 0xff;
      lenBuf[1] = payload.byteLength & 0xff;
      parts.push(await this.session.seal(lenBuf));
      parts.push(await this.session.seal(payload));
    } while (offset < stream.byteLength);
    return concatBytes(...parts);
  }
}

/** Inbound decoder: server salt → subkey → chunks; strips the reply header. */
export class SsAeadInbound {
  private buffer: Uint8Array = new Uint8Array(0);
  private session: AeadSession | null = null;
  private state: "salt" | "len" | "payload" = "salt";
  private expected = 0;
  private headerDone = false;
  private headerBuffer: Uint8Array | null = null;

  constructor(
    private readonly masterKey: Uint8Array,
    private readonly keyLen: number,
  ) {}

  async push(chunk: Uint8Array): Promise<Uint8Array> {
    this.buffer = concatBytes(this.buffer, chunk);
    const out: Uint8Array[] = [];
    for (;;) {
      if (this.state === "salt") {
        if (this.buffer.byteLength < this.keyLen) break;
        const salt = this.take(this.keyLen);
        this.session = await AeadSession.create(await deriveSubkey(this.masterKey, salt, this.keyLen));
        this.state = "len";
      } else if (this.state === "len") {
        if (this.buffer.byteLength < 2 + TAG_LEN) break;
        const lenBytes = await this.session!.open(this.take(2 + TAG_LEN));
        const len = ((lenBytes[0] ?? 0) << 8) | (lenBytes[1] ?? 0);
        if (len > CHUNK_MAX) throw new Error(`invalid chunk length: ${len}`);
        this.expected = len;
        this.state = "payload";
      } else {
        if (this.buffer.byteLength < this.expected + TAG_LEN) break;
        const payload = await this.session!.open(this.take(this.expected + TAG_LEN));
        this.expected = 0;
        this.state = "len";
        const rest = this.stripReplyHeader(payload);
        if (rest.byteLength > 0) out.push(rest);
      }
    }
    return out.length > 0 ? concatBytes(...out) : EMPTY_BYTES;
  }

  private take(n: number): Uint8Array {
    const head = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return head;
  }

  /**
   * First payload may echo [atype][addr][port] (spec) or start directly with
   * data (Xray omits the echo). A valid leading address type is consumed;
   * anything else is treated as data.
   */
  private stripReplyHeader(payload: Uint8Array): Uint8Array {
    if (this.headerDone) return payload;
    const combined = this.headerBuffer ? concatBytes(this.headerBuffer, payload) : payload;
    const atype = combined[0];
    let addrLen: number;
    if (atype === SS_ADDRESS_TYPE.IPV4) {
      addrLen = 4;
    } else if (atype === SS_ADDRESS_TYPE.IPV6) {
      addrLen = 16;
    } else if (atype === SS_ADDRESS_TYPE.DOMAIN) {
      const domainLen = combined[1];
      if (domainLen === undefined) {
        this.headerBuffer = combined;
        return EMPTY_BYTES;
      }
      addrLen = 1 + domainLen;
    } else {
      // Not an address echo — the server sends data directly (Xray does).
      this.headerDone = true;
      this.headerBuffer = null;
      return payload;
    }
    const total = 1 + addrLen + 2;
    if (combined.byteLength < total) {
      this.headerBuffer = combined;
      return EMPTY_BYTES;
    }
    this.headerDone = true;
    this.headerBuffer = null;
    return combined.subarray(total);
  }
}

/** [atype][addr][port BE] — address BEFORE port, and SOCKS5-style atypes. */
export function encodeSsTargetAddress(target: TargetAddress): Uint8Array {
  const wire = toWireAddress(target.host);
  const ssAtype =
    wire.atype === ADDRESS_TYPE.DOMAIN
      ? SS_ADDRESS_TYPE.DOMAIN
      : wire.atype === ADDRESS_TYPE.IPV6
        ? SS_ADDRESS_TYPE.IPV6
        : SS_ADDRESS_TYPE.IPV4;
  const out = new Uint8Array(1 + wire.bytes.byteLength + 2);
  out[0] = ssAtype;
  out.set(wire.bytes, 1);
  const portAt = 1 + wire.bytes.byteLength;
  out[portAt] = (target.port >> 8) & 0xff;
  out[portAt + 1] = target.port & 0xff;
  return out;
}

export interface SsWsTunnelOptions extends WsTunnelOptions {
  /** Shadowsocks password (EVP_BytesToKey derives the master key from it). */
  password: string;
  /** AEAD method; default "aes-256-gcm". */
  method?: SsAeadMethod;
}

export function createSsWsTunnel(options: SsWsTunnelOptions): Tunnel {
  const method = options.method ?? "aes-256-gcm";
  const keyLen = KEY_LENGTHS[method];
  if (!keyLen) {
    throw new Error(
      `unsupported Shadowsocks method: ${JSON.stringify(method)}; browser build supports aes-128-gcm / aes-256-gcm`,
    );
  }
  const masterKey = evpBytesToKey(options.password, keyLen);
  return makeWsTunnel(options, async (target): Promise<ProtocolSession> => {
    const outbound = await SsAeadOutbound.create(masterKey, keyLen);
    const inbound = new SsAeadInbound(masterKey, keyLen);
    const address = encodeSsTargetAddress(target);
    return {
      firstMessage: (initialPayload) => outbound.encode(address, initialPayload),
      inbound: (chunk) => inbound.push(chunk),
    };
  });
}
