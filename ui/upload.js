// The in-chat upload box. Sends the bill's bytes straight to the MCP server via
// the app-only `upload_bill` tool, then asks Claude (as a chat message) to
// read and claim it.
//
// Speaks the MCP Apps postMessage protocol directly instead of bundling
// @modelcontextprotocol/ext-apps: the SDK (plus zod) made this page ~600 KB,
// and the host keeps the iframe at zero height until the handshake finishes
// and the first size-changed notification arrives, so a slow or failed load
// left the box invisible.

import { BILL_TYPES } from "../bill-types.js";

const MAX_BYTES = 20 * 1024 * 1024;
const ACCEPT = [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".heic"];
const PROTOCOL_VERSION = "2026-01-26";

const drop = document.getElementById("drop");
const input = document.getElementById("file");
const list = document.getElementById("list");
const sendBtn = document.getElementById("send");
const status = document.getElementById("status");

const billType = document.getElementById("bill-type");
const purpose = document.getElementById("purpose");

const uploaded = []; // { id, name }

// --- JSON-RPC over postMessage to the host -------------------------------

const host = window.parent;
const pending = new Map();
let nextId = 1;

function request(method, params, timeoutMs = 60_000) {
  const id = nextId++;
  host.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
  });
}

const notify = (method, params) => host.postMessage({ jsonrpc: "2.0", method, params }, "*");

window.addEventListener("message", (e) => {
  if (e.source !== host) return;
  const msg = e.data;
  if (msg?.jsonrpc !== "2.0") return;

  if (msg.id !== undefined && !msg.method) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    msg.error ? p.reject(new Error(msg.error.message || "Host error")) : p.resolve(msg.result);
    return;
  }
  if (msg.method === "ui/notifications/host-context-changed") applyHostContext(msg.params);
  // Acknowledge any host request (e.g. ui/resource-teardown) so it doesn't hang.
  if (msg.id !== undefined) host.postMessage({ jsonrpc: "2.0", id: msg.id, result: {} }, "*");
});

function applyHostContext(ctx) {
  if (ctx?.theme) document.documentElement.dataset.theme = ctx.theme;
  for (const [k, v] of Object.entries(ctx?.styles?.variables ?? {})) {
    if (v) document.documentElement.style.setProperty(k, v);
  }
}

let lastW = 0;
let lastH = 0;
function reportSize() {
  const el = document.documentElement;
  const prev = el.style.height;
  el.style.height = "max-content";
  const height = Math.ceil(el.getBoundingClientRect().height);
  el.style.height = prev;
  const width = Math.ceil(window.innerWidth);
  if (width === lastW && height === lastH) return;
  lastW = width;
  lastH = height;
  notify("ui/notifications/size-changed", { width, height });
}

async function connect() {
  const result = await request(
    "ui/initialize",
    { appInfo: { name: "nht-bill-upload", version: "1.1.0" }, appCapabilities: {}, protocolVersion: PROTOCOL_VERSION },
    10_000
  );
  applyHostContext(result?.hostContext);
  notify("ui/notifications/initialized", {});
  reportSize();
  const ro = new ResizeObserver(() => requestAnimationFrame(reportSize));
  ro.observe(document.documentElement);
  ro.observe(document.body);
}

// --- Upload box ----------------------------------------------------------

function setStatus(msg, kind = "") {
  status.textContent = msg;
  status.className = `status ${kind}`;
}

billType.add(new Option("Select a bill type", ""));
for (const t of BILL_TYPES) billType.add(new Option(t, t));

// Claiming needs at least one uploaded bill plus a bill type and purpose,
// which apply to every bill in this batch.
function refreshSend() {
  sendBtn.disabled = !uploaded.length || !billType.value || !purpose.value.trim();
  sendBtn.textContent = uploaded.length > 1 ? `Claim ${uploaded.length} bills` : "Claim this bill";
}
billType.addEventListener("change", refreshSend);
purpose.addEventListener("input", refreshSend);

function addRow(name) {
  const li = document.createElement("li");
  li.innerHTML = `<span class="name"></span><span class="state">Uploading…</span>`;
  li.querySelector(".name").textContent = name;
  list.appendChild(li);
  return (state, kind) => {
    const s = li.querySelector(".state");
    s.textContent = state;
    s.className = `state ${kind || ""}`;
  };
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function upload(file) {
  const update = addRow(file.name);
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!ACCEPT.includes(ext)) return update(`Unsupported type ${ext}`, "err");
  if (file.size > MAX_BYTES) return update("Too large (max 20 MB)", "err");
  try {
    const result = await request("tools/call", {
      name: "upload_bill",
      arguments: { name: file.name, data_base64: await toBase64(file) },
    });
    if (result?.isError) throw new Error(result.content?.[0]?.text || "Upload failed");
    const { id, name } = result.structuredContent;
    uploaded.push({ id, name });
    update("Uploaded", "ok");
    refreshSend();
  } catch (err) {
    update(err.message, "err");
  }
}

async function handleFiles(files) {
  setStatus("");
  for (const f of files) await upload(f);
}

drop.addEventListener("click", () => input.click());
drop.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && input.click());
input.addEventListener("change", () => handleFiles([...input.files]));
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  handleFiles([...e.dataTransfer.files]);
});

sendBtn.addEventListener("click", async () => {
  sendBtn.disabled = true;
  const ids = uploaded.map((b) => `${b.id} (${b.name})`).join(", ");
  const msg = [
    `I've uploaded my bill(s): ${ids}.`,
    `Bill type: ${billType.value}.`,
    `Purpose of expense: ${purpose.value.trim()}`,
    "Read each with read_bill and file a separate claim for each bill, using this bill type and purpose for all of them.",
  ].join("\n");
  try {
    const res = await request("ui/message", {
      role: "user",
      content: [{ type: "text", text: msg }],
    });
    if (res?.isError) throw new Error("The chat didn't accept the message.");
    setStatus("Sent to Claude. If a Chrome window opens, sign in to the portal there.", "ok");
  } catch (err) {
    refreshSend();
    setStatus(`${err.message} You can also type: claim bill ${uploaded.map((b) => b.id).join(", ")}`, "err");
  }
});

connect().catch((err) => {
  console.error("[nht-upload] handshake failed:", err);
  setStatus(`Couldn't connect to the chat (${err.message}). Try reloading the conversation.`, "err");
  // Still try to make the box visible so the error can be seen.
  reportSize();
});
