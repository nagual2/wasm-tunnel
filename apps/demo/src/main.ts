import { createVlessWsTunnel, type Tunnel } from "wasm-tunnel-client";

interface DemoSettings {
  host: string;
  port: number;
  path: string;
  uuid: string;
  tls: boolean;
  target: string;
  method: string;
  body: string;
}

const STORAGE_KEY = "wasm-tunnel-demo-settings";
const DEFAULTS: DemoSettings = {
  host: "127.0.0.1",
  port: 8080,
  path: "/tunnel",
  uuid: "9f6c2b1e-4a7d-4c83-b5e1-2d3f4a5b6c7d",
  tls: false,
  target: "http://echo:8081/via-tunnel",
  method: "GET",
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
  ($("node-host") as HTMLInputElement).value = settings.host;
  ($("node-port") as HTMLInputElement).value = String(settings.port);
  ($("node-path") as HTMLInputElement).value = settings.path;
  ($("node-uuid") as HTMLInputElement).value = settings.uuid;
  ($("node-tls") as HTMLInputElement).checked = settings.tls;
  ($("target-url") as HTMLInputElement).value = settings.target;
  ($("req-method") as HTMLSelectElement).value = settings.method;
  ($("req-body") as HTMLTextAreaElement).value = settings.body;
}

function collectSettings(): DemoSettings {
  return {
    host: ($("node-host") as HTMLInputElement).value.trim(),
    port: Number(($("node-port") as HTMLInputElement).value),
    path: ($("node-path") as HTMLInputElement).value.trim(),
    uuid: ($("node-uuid") as HTMLInputElement).value.trim(),
    tls: ($("node-tls") as HTMLInputElement).checked,
    target: ($("target-url") as HTMLInputElement).value.trim(),
    method: ($("req-method") as HTMLSelectElement).value,
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
  button.disabled = true;
  try {
    writeSettings(settings);
    const options = {
      host: settings.host,
      port: settings.port,
      uuid: settings.uuid,
      path: settings.path,
      tls: settings.tls,
      timeoutMs: 30_000,
    };
    logLine(`connect ${settings.tls ? "wss" : "ws"}://${settings.host}:${settings.port}${settings.path}`);
    const started = performance.now();
    const tunnel: Tunnel = createVlessWsTunnel(options);
    const method = settings.method;
    const hasBody = method !== "GET" && method !== "HEAD" && settings.body.length > 0;
    const response = await tunnel.fetch(settings.target, {
      method,
      body: hasBody ? settings.body : null,
      headers: hasBody ? { "content-type": "application/json" } : undefined,
    });
    const bodyText = await response.text();
    const elapsed = Math.round(performance.now() - started);
    logLine(`response status=${response.status} bytes=${bodyText.length} in ${elapsed} ms`);
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
