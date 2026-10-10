import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureLoggedIn,
  fillClaim,
  submitPendingClaim,
  inspectClaimForm,
  closeBrowser,
  resetSession,
} from "./browser.js";
import { saveUpload, getBill, renderPreview } from "./bills.js";
import { BILL_TYPES } from "./bill-types.js";

const UPLOAD_UI_URI = "ui://nht/upload.html";
const UPLOAD_UI_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "dist",
  "upload.html",
);
const MCP_APP_MIME = "text/html;profile=mcp-app";

const text = (t) => ({ type: "text", text: t });
// Browser screenshots are best-effort (null on failure); say so instead of erroring.
const image = (b64, mimeType = "image/png") =>
  b64
    ? { type: "image", data: b64, mimeType }
    : text("(Screenshot unavailable — the browser page couldn't be captured.)");
const fail = (msg) => ({ isError: true, content: [text(msg)] });
const log = (...args) => console.error("[nht-mcp]", ...args);

// Portal rule: bill date must be in the current month and not in the future.
function checkBillDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime()))
    throw new Error(`bill_date "${iso}" is not a valid YYYY-MM-DD date.`);
  const now = new Date();
  if (d > now) throw new Error(`bill_date ${iso} is in the future.`);
  if (
    d.getFullYear() !== now.getFullYear() ||
    d.getMonth() !== now.getMonth()
  ) {
    throw new Error(
      `bill_date ${iso} is not in the current month — the portal only accepts bills dated this month.`,
    );
  }
}

// One shared login attempt, so the background login started by claim_bills and
// a later claim_bill call wait on the same browser window.
let loginInFlight = null;
function login(extra) {
  loginInFlight ??= ensureLoggedIn({
    onWaiting: () =>
      extra
        ?.sendNotification?.({
          method: "notifications/message",
          params: {
            level: "info",
            data: "Please sign in to the Nighthack portal in the Chrome window that just opened.",
          },
        })
        .catch(() => {}),
  }).finally(() => (loginInFlight = null));
  return loginInFlight;
}

const server = new McpServer({ name: "nht-mcp", version: "1.0.0" });

server.registerResource(
  "bill-upload-ui",
  UPLOAD_UI_URI,
  { title: "Bill upload box", mimeType: MCP_APP_MIME },
  async () => ({
    contents: [
      {
        uri: UPLOAD_UI_URI,
        mimeType: MCP_APP_MIME,
        text: fs.readFileSync(UPLOAD_UI_FILE, "utf8"),
      },
    ],
  }),
);

server.registerTool(
  "claim_bills",
  {
    title: "Claim bills",
    description: [
      "Start here whenever the user wants to claim / file / reimburse expenses or bills on the Nighthack portal.",
      "Shows an upload box in the chat where the user drops their bill files, and checks the portal login",
      "meanwhile (a Chrome window opens only if they need to sign in). After this, wait: the upload box will send a message with bill ids.",
    ].join(" "),
    inputSchema: {},
    _meta: {
      ui: { resourceUri: UPLOAD_UI_URI },
      "ui/resourceUri": UPLOAD_UI_URI,
    },
  },
  async (_args, extra) => {
    login(extra).catch((err) => log("Background login failed:", err.message));
    return {
      content: [
        text(
          "Upload box shown. Checking the portal login in the background — if the user isn't signed in, a Chrome " +
            "window opens for them to sign in. " +
            "Wait for the user to upload bills; the box will send their bill ids. If the upload box doesn't appear, " +
            "this chat app doesn't support MCP Apps — tell the user so.",
        ),
      ],
    };
  },
);

server.registerTool(
  "upload_bill",
  {
    title: "Receive an uploaded bill",
    description:
      "Called by the upload box only. Stores one bill file sent from the chat UI.",
    inputSchema: {
      name: z.string().describe("Original file name."),
      data_base64: z.string().describe("File contents, base64-encoded."),
    },
    _meta: { ui: { resourceUri: UPLOAD_UI_URI, visibility: ["app"] } },
  },
  async ({ name, data_base64 }) => {
    try {
      const { id, name: stored, bytes } = await saveUpload(name, data_base64);
      log(`Stored bill ${id} (${stored}, ${bytes} bytes)`);
      return {
        content: [text(`Stored bill ${id} (${stored}).`)],
        structuredContent: { id, name: stored },
      };
    } catch (err) {
      return fail(err.message);
    }
  },
);

server.registerTool(
  "read_bill",
  {
    title: "Read an uploaded bill",
    description: [
      "Returns an image of an uploaded bill (first page for PDFs) so you can read it.",
      "Extract: bill date, biller/merchant, bill/invoice number, total amount, GST amount and GSTIN if present.",
      "Then call claim_bill once per bill. The upload box message gives a bill type and purpose that apply to",
      "every bill in it; use them as-is. Without that, ask the user for bill_type and purpose.",
    ].join(" "),
    inputSchema: {
      bill_id: z
        .string()
        .describe("The 8-character id from the upload box message."),
    },
  },
  async ({ bill_id }) => {
    try {
      const file = getBill(bill_id);
      return {
        content: [
          text(`Bill ${bill_id}: ${path.basename(file)}`),
          image(await renderPreview(file), "image/jpeg"),
        ],
      };
    } catch (err) {
      return fail(err.message);
    }
  },
);

server.registerTool(
  "login",
  {
    title: "Log in to Nighthack portal",
    description:
      "Checks the Nighthack Associate Portal session. If there is no saved session, opens a visible Chrome window where the user completes OAuth sign-in; this call waits until they are signed in (up to 5 minutes). The browser runs headless otherwise.",
    inputSchema: {},
  },
  async (_args, extra) => {
    try {
      const { alreadyLoggedIn } = await login(extra);
      return {
        content: [
          text(
            alreadyLoggedIn
              ? "Already logged in."
              : "Login complete — session saved for next time.",
          ),
        ],
      };
    } catch (err) {
      return fail(err.message);
    }
  },
);

server.registerTool(
  "claim_bill",
  {
    title: "Fill an expense claim",
    description: [
      "Fills (but does not submit) a new expense claim on portal.nighthack.in and attaches the uploaded bill.",
      "Call read_bill first and take the fields from the bill. Ask the user for anything you cannot read",
      "reliably (especially bill_type and purpose). If the user isn't signed in yet, this waits for them to",
      "finish OAuth login in Chrome. Returns a screenshot of the filled form: show it to the user, and only",
      "after they confirm call submit_claim.",
    ].join(" "),
    inputSchema: {
      bill_id: z
        .string()
        .describe("Id of the uploaded bill (from the upload box message)."),
      bill_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe(
          "Bill/invoice date, YYYY-MM-DD. Must be in the current month.",
        ),
      bill_type: z
        .enum(BILL_TYPES)
        .describe(
          "Expense category as shown in the portal. Use the type the user picked in the upload box, if any.",
        ),
      bill_sub_type: z
        .string()
        .optional()
        .describe(
          'Sub-type if the category has one, e.g. "Lunch", "Dinner", "Snacks / Coffee".',
        ),
      biller: z.string().describe("Merchant / vendor name on the bill."),
      bill_number: z.string().describe("Bill or invoice number."),
      bill_amount: z.number().positive().describe("Total amount in INR."),
      purpose: z
        .string()
        .describe(
          "Why the expense was incurred. Use the purpose the user typed in the upload box, if any.",
        ),
      service_tax: z
        .number()
        .nonnegative()
        .optional()
        .describe("GST / service tax amount, if shown."),
      service_tax_number: z
        .string()
        .optional()
        .describe("GSTIN / service tax number of the biller, if shown."),
      on_behalf_of: z
        .string()
        .optional()
        .describe("Only if claiming on behalf of someone else."),
    },
  },
  async ({ bill_id, ...args }, extra) => {
    try {
      const file_path = getBill(bill_id);
      checkBillDate(args.bill_date);
      await login(extra);
      const { filled, skipped, formValues, screenshot } = await fillClaim({
        ...args,
        file_path,
      });
      const lines = [
        "Claim form filled (NOT submitted yet).",
        "",
        ...Object.entries(filled).map(([k, v]) => `- ${k}: ${v}`),
        "",
        "Values read back from the form:",
        ...Object.entries(formValues).map(([k, v]) => `- ${k}: ${v}`),
      ];
      if (skipped.length)
        lines.push(
          "",
          `Could not find form fields for: ${skipped.join(", ")} — the browser is headless, so the user can't type them in; run inspect_claim_form to see the form's labels and tell the user which field matcher in browser.js needs updating.`,
        );
      lines.push(
        "",
        screenshot
          ? "Check the screenshot and the read-back values with the user, then call submit_claim to submit."
          : "No screenshot this time. Check the read-back values with the user, then call submit_claim to submit.",
      );
      return { content: [text(lines.join("\n")), image(screenshot)] };
    } catch (err) {
      return fail(err.message);
    }
  },
);

server.registerTool(
  "submit_claim",
  {
    title: "Submit the filled claim",
    description:
      "Clicks submit on the claim form filled by claim_bill. Only call after the user has confirmed the details.",
    inputSchema: {},
  },
  async () => {
    try {
      const { ok, message, screenshot } = await submitPendingClaim();
      return { isError: !ok, content: [text(message), image(screenshot)] };
    } catch (err) {
      return fail(err.message);
    }
  },
);

server.registerTool(
  "inspect_claim_form",
  {
    title: "Inspect the claim form",
    description:
      "Debug helper: opens the new-claim form and lists every field the automation can see (labels, types, dropdown options) plus a screenshot. Use it when claim_bill skips fields or picks the wrong option.",
    inputSchema: {},
  },
  async (_args, extra) => {
    try {
      await login(extra);
      const { controls, buttons, screenshot } = await inspectClaimForm();
      return {
        content: [
          text(JSON.stringify({ controls, buttons }, null, 2)),
          image(screenshot),
        ],
      };
    } catch (err) {
      return fail(err.message);
    }
  },
);

server.registerTool(
  "logout",
  {
    title: "Forget the saved session",
    description:
      "Closes the browser and deletes the saved Chrome profile, so the next call asks the user to log in again.",
    inputSchema: {},
  },
  async () => {
    await resetSession();
    return { content: [text("Session cleared.")] };
  },
);

const shutdown = async () => {
  await closeBrowser();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

await server.connect(new StdioServerTransport());
log("ready");
