/**
 * wasm-tunnel client: a thin browser-first VLESS-over-WebSocket tunnel
 * client for application HTTP traffic (not a system VPN).
 */

export { concatBytes } from "./bytes";
export { parseUUID, stringifyUUID } from "./uuid";
export {
  encodeVlessRequestHeader,
  parseIPv4,
  parseIPv6,
  VlessResponseDecoder,
  VLESS_ADDRESS_TYPE,
  VLESS_COMMAND,
  VLESS_VERSION,
} from "./protocol";
export { encodeHttpRequest, HttpResponseParser } from "./http";
export {
  createVlessWsTunnel,
  type Tunnel,
  type TunnelRequestInit,
  type VlessWsTunnelOptions,
} from "./tunnel";
