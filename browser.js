// Playwright automation for portal.nighthack.in.
// Uses a persistent Chrome profile so the OAuth session survives between runs:
// the user logs in once in a visible window, and later runs reuse that session.
import { chromium } from "playwright";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const BASE_URL = process.env.NHT_BASE_URL || "https://portal.nighthack.in/";
const PROFILE_DIR = process.env.NHT_PROFILE_DIR || path.join(os.homedir(), ".nht-mcp", "chrome-profile");
const LOGIN_TIMEOUT_MS = Number(process.env.NHT_LOGIN_TIMEOUT_MS || 5 * 60 * 1000);

const log = (...args) => console.error("[nht-mcp]", ...args); // stdout is reserved for MCP

// Runs headless, except while the user signs in: Google blocks OAuth in
// headless browsers, so login relaunches Chrome visibly, then goes back to
// headless. NHT_HEADLESS=0 keeps the window visible throughout (debugging).
const HEADLESS = process.env.NHT_HEADLESS !== "0";

let context = null;
let contextHeadless = null;
let page = null;
let launching = null; // two launches on one profile would fail, so share one

async function launch(headless) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const opts = {
    headless,
    viewport: headless ? { width: 1440, height: 900 } : null,
    // Google refuses sign-in from browsers that advertise automation.
    args: ["--disable-blink-features=AutomationControlled", ...(headless ? [] : ["--start-maximized"])],
    ignoreDefaultArgs: ["--enable-automation"],
  };
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, { ...opts, channel: "chrome" });
  } catch (err) {
    log("Chrome channel unavailable, falling back to bundled Chromium:", err.message);
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, opts);
  }
  ctx.on("close", () => {
    if (context !== ctx) return;
    context = null;
    page = null;
  });
  context = ctx;
  contextHeadless = headless;
}

// `visible: true` (for login) relaunches Chrome in a window if it's headless.
export async function getPage({ visible = false } = {}) {
  await launching;
  const headless = HEADLESS && !visible;
  if (context && contextHeadless !== headless && (visible || !pending)) await closeBrowser();
  if (!context) {
    launching ??= launch(headless).finally(() => (launching = null));
    await launching;
  }
  if (!page || page.isClosed()) {
    page = context.pages().find((p) => !p.isClosed()) || (await context.newPage());
  }
  return page;
}

export async function closeBrowser() {
  const ctx = context;
  context = null;
  page = null;
  pending = null;
  if (ctx) await ctx.close().catch(() => {});
}

export async function resetSession() {
  await closeBrowser();
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
}

// Firebase keeps the signed-in user in IndexedDB under "firebase:authUser:*".
async function hasFirebaseUser(p) {
  return p
    .evaluate(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open("firebaseLocalStorageDb");
          req.onerror = () => resolve(false);
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("firebaseLocalStorage")) return resolve(false);
            const all = db.transaction("firebaseLocalStorage").objectStore("firebaseLocalStorage").getAllKeys();
            all.onsuccess = () => resolve(all.result.some((k) => String(k).startsWith("firebase:authUser:")));
            all.onerror = () => resolve(false);
          };
        })
    )
    .catch(() => false);
}

async function claimsNavVisible(p) {
  const nav = p.getByRole("link", { name: /^claims$/i }).or(p.getByRole("button", { name: /^claims$/i }));
  return nav.first().isVisible().catch(() => false);
}

async function isLoggedIn(p) {
  return (await hasFirebaseUser(p)) && (await claimsNavVisible(p));
}

async function openPortal(p) {
  if (!p.url().startsWith(BASE_URL)) await p.goto(BASE_URL, { waitUntil: "domcontentloaded" });
}

/**
 * Make sure the portal session is authenticated. Checks headlessly first; if
 * signed out, opens a visible Chrome window and waits for the user to complete
 * OAuth there, then closes it so later work runs headless again.
 */
export async function ensureLoggedIn({ timeoutMs = LOGIN_TIMEOUT_MS, onWaiting } = {}) {
  const p = await getPage();
  await openPortal(p);
  // Give the SPA a moment to restore a saved session.
  const quickDeadline = Date.now() + 10_000;
  while (Date.now() < quickDeadline) {
    if (await isLoggedIn(p)) return { alreadyLoggedIn: true };
    await p.waitForTimeout(500);
  }

  log("Not logged in — opening Chrome for the user to sign in.");
  const visible = await getPage({ visible: true });
  await openPortal(visible);
  await visible.bringToFront();
  onWaiting?.();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!context) throw new Error("The browser window was closed before login finished.");
    const current = await getPage({ visible: true });
    if (await isLoggedIn(current)) {
      log("Login detected.");
      if (HEADLESS) await closeBrowser(); // session is saved in the profile; reopen headless on next use
      return { alreadyLoggedIn: false };
    }
    await current.waitForTimeout(1000);
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for you to log in to the portal.`);
}

// ---------------------------------------------------------------------------
// Claim form
// ---------------------------------------------------------------------------

// Label patterns per field, tried in order. `exclude` stops e.g. "Service Tax"
// from matching the "Service Tax Number" input.
const FIELDS = {
  on_behalf_of: { match: [/on\s*behalf/i] },
  bill_date: { match: [/bill\s*date/i, /invoice\s*date/i, /^date/i] },
  bill_type: { match: [/bill\s*type/i, /expense\s*type/i, /claim\s*type/i, /category/i], exclude: /sub/i },
  bill_sub_type: { match: [/sub[\s-]*type/i, /sub[\s-]*category/i] },
  biller: { match: [/biller/i, /vendor/i, /merchant/i] },
  // The portal labels it "Bill / Invoice #".
  bill_number: { match: [/(bill|invoice)\s*(#|no\b|num)/i, /bill\s*\/\s*invoice(?!\s*date)/i], exclude: /date/i },
  bill_amount: { match: [/bill\s*amount/i, /^amount/i, /amount/i], exclude: /tax|approved/i },
  service_tax: { match: [/service\s*tax/i, /gst\s*amount/i, /tax\s*amount/i], exclude: /no\b|num|gstin/i },
  service_tax_number: { match: [/service\s*tax\s*(no|num)/i, /gstin/i, /gst\s*(no|num)/i, /tax\s*(no|num)/i] },
  purpose: { match: [/purpose/i, /description/i, /reason/i] },
};

// Tags every form control inside `root` with data-nht-idx and returns a
// description of each one (best-effort label, type, options).
async function describeControls(scope) {
  return scope.evaluate((root) => {
    const sel = 'input, select, textarea, [role="combobox"], button[aria-haspopup="listbox"]';
    const clean = (s) => (s || "").replace(/\s+/g, " ").replace(/\*/g, "").trim();
    const labelFor = (el) => {
      if (el.labels && el.labels.length) return clean(el.labels[0].innerText);
      if (el.getAttribute("aria-label")) return clean(el.getAttribute("aria-label"));
      const lb = el.getAttribute("aria-labelledby");
      if (lb) return clean(lb.split(" ").map((id) => document.getElementById(id)?.innerText).join(" "));
      // Walk up a few levels looking for a sibling label-ish element.
      let node = el;
      for (let i = 0; i < 4 && node && node !== root; i++) {
        const parent = node.parentElement;
        if (!parent) break;
        const lab = parent.querySelector(":scope > label, :scope > span, :scope > p, :scope > div > label");
        if (lab && !lab.contains(el) && clean(lab.innerText)) return clean(lab.innerText);
        let prev = node.previousElementSibling;
        while (prev) {
          if (!prev.matches(sel) && clean(prev.innerText)) return clean(prev.innerText);
          prev = prev.previousElementSibling;
        }
        node = parent;
      }
      return "";
    };
    return [...root.querySelectorAll(sel)]
      .filter((el) => el.type === "file" || el.offsetParent !== null)
      .filter((el) => !["hidden", "submit", "button", "checkbox", "radio"].includes(el.type))
      .map((el, i) => {
        el.setAttribute("data-nht-idx", String(i));
        return {
          idx: i,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type") || el.getAttribute("role") || "",
          label: labelFor(el),
          name: el.getAttribute("name") || el.id || "",
          placeholder: el.getAttribute("placeholder") || "",
          value: el.value ?? "",
          options: el.tagName === "SELECT" ? [...el.options].map((o) => clean(o.text)) : undefined,
        };
      });
  });
}

function pickControl(controls, field) {
  const { match, exclude } = FIELDS[field];
  for (const re of match) {
    const hit = controls.find((c) => {
      const text = [c.label, c.placeholder, c.name].join(" | ");
      return c.type !== "file" && re.test(text) && !(exclude && exclude.test(c.label || c.placeholder || c.name));
    });
    if (hit) return hit;
  }
  return null;
}

function bestOption(options, wanted) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const w = norm(wanted);
  const exact = options.findIndex((o) => norm(o) === w);
  if (exact >= 0) return exact;
  return options.findIndex((o) => norm(o) && (norm(o).includes(w) || w.includes(norm(o))));
}

async function setControl(p, scope, control, value, field) {
  const loc = scope.locator(`[data-nht-idx="${control.idx}"]`);
  if (control.tag === "select") {
    const i = bestOption(control.options, String(value));
    if (i < 0) throw new Error(`No option matching "${value}" for ${field}. Available: ${control.options.filter(Boolean).join(", ")}`);
    await loc.selectOption({ index: i });
    return control.options[i];
  }
  if (control.type === "combobox" || control.tag === "button") {
    await loc.click();
    const options = p.getByRole("option");
    await options.first().waitFor({ timeout: 5000 });
    const texts = (await options.allInnerTexts()).map((t) => t.trim());
    const i = bestOption(texts, String(value));
    if (i < 0) throw new Error(`No option matching "${value}" for ${field}. Available: ${texts.join(", ")}`);
    await options.nth(i).click();
    return texts[i];
  }
  await loc.fill(String(value));
  return String(value);
}

async function openClaimForm(p) {
  await openPortal(p); // a fresh headless launch starts on about:blank
  await p.getByRole("link", { name: /^claims$/i }).or(p.getByRole("button", { name: /^claims$/i })).first().click();
  await p.waitForLoadState("domcontentloaded");
  const newClaim = p
    .getByRole("button", { name: /(new|add|raise|submit|create|file)\s*(expense\s*)?claim|new\s*expense|add\s*expense/i })
    .first();
  await newClaim.waitFor({ timeout: 15_000 });
  await newClaim.click();
  const dialog = p.getByRole("dialog").last();
  try {
    await dialog.waitFor({ timeout: 5000 });
    return dialog;
  } catch {
    const form = p.locator("form").last();
    await form.waitFor({ timeout: 5000 });
    return form;
  }
}

const withTimeout = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))]);

// Best-effort: returns base64 PNG, or null. macOS stops painting a Chrome window
// that's minimized or hidden behind Claude, and page.screenshot() then waits
// for a frame that never comes — so bring it forward, keep the timeout short,
// fall back to a raw CDP capture, and never let a screenshot fail the claim.
async function screenshot(p) {
  await p.bringToFront().catch(() => {});
  try {
    return (await p.screenshot({ timeout: 10_000, animations: "disabled", caret: "hide" })).toString("base64");
  } catch (err) {
    log("page.screenshot failed, trying CDP capture:", err.message);
  }
  let cdp;
  try {
    cdp = await p.context().newCDPSession(p);
    const { data } = await withTimeout(cdp.send("Page.captureScreenshot", { format: "png" }), 10_000, "CDP capture");
    return data;
  } catch (err) {
    log("CDP screenshot failed too:", err.message);
    return null;
  } finally {
    cdp?.detach().catch(() => {});
  }
}

// What the form actually holds now, label → value, so the fill can be checked
// even without a screenshot.
async function readFormValues(scope) {
  const controls = await describeControls(scope);
  return Object.fromEntries(
    controls
      .filter((c) => c.type !== "file" && c.value !== "")
      .map((c) => [c.label || c.placeholder || c.name || `field ${c.idx}`, c.value])
  );
}

// The form left open by fillClaim(), waiting for submitClaim().
let pending = null;

export async function inspectClaimForm() {
  const p = await getPage();
  const scope = await openClaimForm(p);
  const controls = await describeControls(scope);
  const buttons = await scope.getByRole("button").allInnerTexts();
  return { controls, buttons: buttons.map((b) => b.trim()).filter(Boolean), screenshot: await screenshot(p) };
}

export async function fillClaim(claim) {
  const p = await getPage();
  const scope = await openClaimForm(p);
  const filled = {};
  const skipped = [];

  // Order matters: sub-type options depend on the chosen bill type.
  const order = [
    "on_behalf_of", "bill_date", "bill_type", "bill_sub_type", "biller",
    "bill_number", "bill_amount", "service_tax", "service_tax_number", "purpose",
  ];
  for (const field of order) {
    const value = claim[field];
    if (value === undefined || value === null || value === "") continue;
    const controls = await describeControls(scope); // re-scan: fields can appear dynamically
    const control = pickControl(controls, field);
    if (!control) {
      skipped.push(field);
      continue;
    }
    filled[field] = await setControl(p, scope, control, value, field);
    await p.waitForTimeout(250);
  }

  // Attach the bill and wait for the upload to Firebase Storage to finish.
  const fileInput = scope.locator('input[type="file"]').first();
  await fileInput.setInputFiles(claim.file_path);
  const fileName = path.basename(claim.file_path);
  await scope.getByText(fileName, { exact: false }).first().waitFor({ timeout: 60_000 }).catch(() => {});
  await scope.getByText(/uploading/i).first().waitFor({ state: "hidden", timeout: 60_000 }).catch(() => {});
  filled.attachment = fileName;

  pending = { scope, claim };
  const formValues = await readFormValues(scope).catch(() => ({}));
  return { filled, skipped, formValues, screenshot: await screenshot(p) };
}

export async function submitPendingClaim() {
  if (!pending) throw new Error("No filled claim form is waiting. Call claim_bill first.");
  const p = await getPage();
  const { scope } = pending;
  const submit = scope.getByRole("button", { name: /submit|save|create|raise|confirm/i }).last();
  await submit.click();

  try {
    await scope.waitFor({ state: "hidden", timeout: 30_000 });
    pending = null;
    return { ok: true, message: "Claim submitted — the form closed without errors.", screenshot: await screenshot(p) };
  } catch {
    const text = (await scope.innerText().catch(() => "")).slice(0, 1500);
    return { ok: false, message: `The form is still open — the portal probably rejected it.\n\n${text}`, screenshot: await screenshot(p) };
  }
}
