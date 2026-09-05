/**
 * Generic tunnel factory with lazy per-protocol loading. Import from
 * "wasm-tunnel-client/create-tunnel" — the default package entry stays
 * thin and only contains the core + VLESS.
 */

import type { Tunnel } from "./tunnel";
import type { VlessWsTunnelOptions } from "./protocols/vless";
import type { SsWsTunnelOptions } from "./protocols/shadowsocks";

export type CreateTunnelOptions =
  | ({ protocol: "vless" } & VlessWsTunnelOptions)
  | ({ protocol: "shadowsocks" } & SsWsTunnelOptions);

/**
 * Create a tunnel by protocol name, loading the protocol module on demand.
 * Protocols may also be imported directly (tree-shakable, synchronous):
 * `createVlessWsTunnel` from the default entry, `createSsWsTunnel` from
 * "wasm-tunnel-client/shadowsocks".
 */
export async function createTunnel(options: CreateTunnelOptions): Promise<Tunnel> {
  switch (options.protocol) {
    case "vless": {
      const { createVlessWsTunnel } = await import("./protocols/vless");
      return createVlessWsTunnel(options);
    }
    case "shadowsocks": {
      const { createSsWsTunnel } = await import("./protocols/shadowsocks");
      return createSsWsTunnel(options);
    }
  }
}
