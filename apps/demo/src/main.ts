import type { Tunnel } from "wasm-tunnel-client";
import type { SwTunnelConfig } from "wasm-tunnel-client/sw";

interface DemoSettings {
  protocol: "vless" | "shadowsocks";
  host: string;
  port: number;
  path: string;
  uuid: string;
  password: string;
  method: "aes-128-gcm" | "aes-256-gcm";
  tls: boolean;
  target: string;
  methodReq: string;
  body: string;
}

const STORAGE_KEY = "wasm-tunnel-demo-settings";
const DEFAULTS: DemoSettings = {
  protocol: "vless",
  host: "127.0.0.1",
  port: 8080,
  path: "/tunnel",
  uuid: "9f6c2b1e-4a7d-4c83-b5e1-2d3f4a5b6c7d",
  password: "",
  method: "aes-256-gcm",
  tls: false,
  target: "http://echo:8081/via-tunnel",
  methodReq: "GET",
  body: "",
};

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

function readSettings(): DemoSettings {
  let saved: Partial<DemoSettings> = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<DemoSettings>;
  } catch {
    saved = {};
  }
  return { ...DEFAULTS, ...saved };
}

function writeSettings(settings: DemoSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function logLine(message: string): void {
  const log = $("log");
  const time = new Date().toISOString().slice(11, 23);
  log.textContent += `${time}  ${message}\n`;
  log.scrollTop = log.scrollHeight;
}

function fillForm(settings: DemoSettings): void {
  ($("protocol") as HTMLSelectElement).value = settings.protocol;
  ($("node-host") as HTMLInputElement).value = settings.host;
  ($("node-port") as HTMLInputElement).value = String(settings.port);
  ($("node-path") as HTMLInputElement).value = settings.path;
  ($("node-uuid") as HTMLInputElement).value = settings.uuid;
  ($("ss-password") as HTMLInputElement).value = settings.password;
  ($("ss-method") as HTMLSelectElement).value = settings.method;
  ($("node-tls") as HTMLInputElement).checked = settings.tls;
  ($("target-url") as HTMLInputElement).value = settings.target;
  ($("req-method") as HTMLSelectElement).value = settings.methodReq;
  ($("req-body") as HTMLTextAreaElement).value = settings.body;
  syncProtocolFields();
}

function syncProtocolFields(): void {
  const protocol = ($("protocol") as HTMLSelectElement).value;
  const isSs = protocol === "shadowsocks";
  ($("uuid-label") as HTMLElement).hidden = isSs;
  ($("ss-password-label") as HTMLElement).hidden = !isSs;
  ($("ss-method-label") as HTMLElement).hidden = !isSs;
}

function collectSettings(): DemoSettings {
  const protocol = ($("protocol") as HTMLSelectElement).value as DemoSettings["protocol"];
  return {
    protocol,
    host: ($("node-host") as HTMLInputElement).value.trim(),
    port: Number(($("node-port") as HTMLInputElement).value),
    path: ($("node-path") as HTMLInputElement).value.trim(),
    uuid: ($("node-uuid") as HTMLInputElement).value.trim(),
    password: ($("ss-password") as HTMLInputElement).value,
    method: ($("ss-method") as HTMLSelectElement).value as DemoSettings["method"],
    tls: ($("node-tls") as HTMLInputElement).checked,
    target: ($("target-url") as HTMLInputElement).value.trim(),
    methodReq: ($("req-method") as HTMLSelectElement).value,
    body: ($("req-body") as HTMLTextAreaElement).value,
  };
}

function showResult(response: Response, bodyText: string, elapsedMs: number): void {
  const section = $("result");
  section.hidden = false;
  const pretty = (() => {
    try {
      return JSON.stringify(JSON.parse(bodyText), null, 2);
    } catch {
      return bodyText;
    }
  })();
  ($("out-status") as HTMLElement).textContent = `${response.status} ${response.statusText} — ${elapsedMs} ms via tunnel`;
  ($("out-headers") as HTMLElement).textContent =
    [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n") || "(no headers)";
  ($("out-body") as HTMLElement).textContent = pretty || "(empty body)";
}

async function run(): Promise<void> {
  const button = $("btn-go") as HTMLButtonElement;
  const settings = collectSettings();
  const viaSw = ($("sw-mode") as HTMLInputElement).checked;
  button.disabled = true;
  try {
    writeSettings(settings);
    const started = performance.now();
    const method = settings.methodReq;
    const hasBody = method !== "GET" && method !== "HEAD" && settings.body.length > 0;
    let response: Response;
    if (viaSw) {
      // Lazy load: the SW helper (page side) is fetched on first use.
      const { installTunnelServiceWorker, tunnelFetch } = await import("wasm-tunnel-client/sw");
      const config: SwTunnelConfig = {
        protocol: settings.protocol,
        host: settings.host,
        port: settings.port,
        path: settings.path,
        tls: settings.tls,
        timeoutMs: 30_000,
        uuid: settings.uuid,
        password: settings.password,
        method: settings.method,
      };
      logLine("registering service worker /sw.js …");
      await installTunnelServiceWorker("/sw.js", { config });
      logLine("sw registered — request goes page → sw → tunnel");
      response = await tunnelFetch(settings.target, {
        method,
        body: hasBody ? settings.body : null,
        headers: hasBody ? { "content-type": "application/json" } : undefined,
      });
    } else {
      // Lazy load: the protocol module is fetched on first use, keeping the
      // demo bundle at core+VLESS until Shadowsocks is actually selected.
      const { createTunnel } = await import("wasm-tunnel-client/create-tunnel");
      const tunnel: Tunnel = await createTunnel({
        protocol: settings.protocol,
        host: settings.host,
        port: settings.port,
        path: settings.path,
        tls: settings.tls,
        timeoutMs: 30_000,
        uuid: settings.uuid,
        password: settings.password,
        method: settings.method,
      });
      logLine(
        `connect via ${settings.protocol}: ${settings.tls ? "wss" : "ws"}://${settings.host}:${settings.port}${settings.path}`,
      );
      response = await tunnel.fetch(settings.target, {
        method,
        body: hasBody ? settings.body : null,
        headers: hasBody ? { "content-type": "application/json" } : undefined,
      });
    }
    const bodyText = await response.text();
    const elapsed = Math.round(performance.now() - started);
    const mode = viaSw ? "sw" : "page";
    logLine(`response status=${response.status} bytes=${bodyText.length} in ${elapsed} ms [${mode}]`);
    showResult(response, bodyText, elapsed);
  } catch (error) {
    logLine(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    ($("result") as HTMLElement).hidden = true;
  } finally {
    button.disabled = false;
  }
}

fillForm(readSettings());
logLine("demo ready — configure the node above and press the button");
$("btn-go").addEventListener("click", () => void run());
$("protocol").addEventListener("change", syncProtocolFields);
