/**
 * wasm-tunnel client default entry: core + VLESS. Kept deliberately thin —
 * other protocols live behind subpath exports ("./shadowsocks") and the lazy
 * factory ("./create-tunnel") so unused protocols never reach the bundle.
 */

export { concatBytes } from "./bytes";
export { parseUUID, stringifyUUID } from "./uuid";
export { ADDRESS_TYPE, parseIPv4, parseIPv6 } from "./address";
export { encodeHttpRequest, HttpResponseParser } from "./http";
export {
  normalizeNodeHost,
  type TargetAddress,
  type Tunnel,
  type TunnelRequestInit,
  type WsTunnelOptions,
} from "./tunnel";
export {
  createVlessWsTunnel,
  encodeVlessRequestHeader,
  VlessResponseDecoder,
  VLESS_COMMAND,
  VLESS_VERSION,
  type VlessResponseHeader,
  type VlessWsTunnelOptions,
} from "./protocols/vless";
export { createTunnel, type CreateTunnelOptions } from "./create-tunnel";
export {
  DEFAULT_SW_ROUTES,
  SwTunnelController,
  installTunnelServiceWorker,
  normalizeSwRoutes,
  resolveTunnelTarget,
  swErrorResponse,
  swPartsToResponse,
  tunnelFetch,
  tunnelResponseToParts,
  type InstallTunnelServiceWorkerOptions,
  type SwFetchInput,
  type SwFetchOutcome,
  type SwTunnelConfig,
  type TunnelFetchOptions,
} from "./sw";
