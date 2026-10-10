# nht-mcp

File expense claims on the Nighthack Associate Portal from Claude Desktop. Drop your bill photos or PDFs into the chat, pick a bill type, type a purpose, and Claude reads each bill and fills in a claim for it. Nothing is submitted until you confirm.

Works on macOS, Windows and Linux.

## How it works

1. You tell Claude "claim my bills". An upload box appears in the chat.
2. You drop in one or more bills, choose a **Bill Type**, type the **Purpose of Expense**, and click **Claim**.
3. Claude reads each bill: date, biller, bill number, amount and GSTIN.
4. A browser running in the background fills in one claim per bill on the portal and attaches the bill.
5. Claude shows you what was filled in, with a screenshot. You say "submit", and only then is the claim submitted.

The first time, a Chrome window opens so you can sign in to the portal with Google. Your sign-in is saved, so after that the browser stays hidden.

## Requirements

- **Claude Desktop.** The upload box needs Claude Desktop; it doesn't appear in claude.ai in a browser. Claude Desktop is officially available for macOS and Windows. On Linux, only community builds exist.
- **Node.js 22.13 or newer.** Check with `node -v`. Install from [nodejs.org](https://nodejs.org) or with Homebrew (`brew install node`).
- **Google Chrome.** If you don't have Chrome, run `npx playwright install chromium` after installing (on Linux, `npx playwright install --with-deps chromium`).
- **Git**
- An account on the Nighthack portal

## Install

macOS / Linux (Terminal):

```sh
git clone https://github.com/OWNER/nht-mcp.git
cd nht-mcp
npm install
npm run setup
```

Windows (PowerShell):

```powershell
git clone https://github.com/OWNER/nht-mcp.git
cd nht-mcp
npm install
npm run setup
```

`npm install` also builds the upload box. `npm run setup` adds nht-mcp to Claude Desktop's config file. It doesn't change any of your other settings, and it saves a backup of the file next to it as `claude_desktop_config.json.bak`.

Then **quit Claude Desktop completely and open it again**:

- macOS: press **⌘Q**. Closing the window isn't enough.
- Windows: right-click the Claude icon in the system tray and choose **Quit**.

To check that it worked, go to **Settings → Developer** in Claude Desktop. `nht` should be listed as running.

<details>
<summary>Setting it up by hand instead</summary>

Open **Settings → Developer → Edit Config** in Claude Desktop and add this, with full paths to `node` and to `server.js` in your clone. Claude Desktop doesn't use your shell's PATH, so `"command": "node"` usually doesn't work.

```json
{
  "mcpServers": {
    "nht": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/nht-mcp/server.js"]
    }
  }
}
```

To find the path to node, run `which node` on macOS and Linux, or `where node` on Windows. On Windows, write backslashes twice in JSON, for example `"C:\\Program Files\\nodejs\\node.exe"`.

</details>

## Use it

1. Open a new chat in Claude Desktop and say **"claim my bills"**.
2. If a Chrome window opens, sign in to the portal there. It closes by itself once you're signed in.
3. Drop your bills into the upload box. Choose the bill type, type the purpose, and click **Claim**.
4. Check the details Claude shows for each claim, then reply **"submit"**.

Uploading several bills at once creates a separate claim for each one, all with the same bill type and purpose. If your bills have different types, upload them in separate batches.

### Rules

- The portal only accepts bills dated in the **current month**.
- Accepted files: PDF, JPG, PNG, WEBP, HEIC, up to **20 MB** each. HEIC (iPhone) photos are converted to JPG. For PDFs, Claude reads the first page.
- Bill types: Fuel / Cab, Food, Travel, Stay, Hardware / Equipment, Learning & Certification, Subscription, Others.

## Your data

- Uploaded bills are saved on your computer in `~/.nht-mcp/uploads` (on Windows, `%USERPROFILE%\.nht-mcp\uploads`).
- Your portal sign-in is saved in `~/.nht-mcp/chrome-profile`, a separate browser profile. Your normal Chrome isn't touched.
- To read a bill, Claude gets an image of it, like any picture you paste into a chat.
- The bill is uploaded to the portal as an attachment when Claude fills in the claim form, before you confirm. The claim itself is submitted only after you say so.
- To sign out, ask Claude to **log out of the portal**. This deletes the saved session.

## Update

```sh
cd nht-mcp
git pull
npm install
```

Then quit and reopen Claude Desktop.

## Uninstall

```sh
cd nht-mcp
npm run uninstall-claude
```

Then delete the `nht-mcp` folder and `~/.nht-mcp`, and restart Claude Desktop.

## Troubleshooting

**The upload box doesn't appear.** Use Claude Desktop, not claude.ai in a browser, and start a new chat after restarting. Check that `nht` is running under **Settings → Developer**.

**`nht` shows as failed in Settings → Developer.** Run `node -v` and make sure it's 22.13 or newer, then run `npm install` and `npm run setup` again. The server's log is at:
- macOS: `~/Library/Logs/Claude/mcp-server-nht.log`
- Windows: `%APPDATA%\Claude\logs\mcp-server-nht.log`

**Claude Desktop was installed from the Microsoft Store.** Its config file may be somewhere else. Open **Settings → Developer → Edit Config** to see where it is, then run:
`npm run setup -- --config "C:\path\to\claude_desktop_config.json"`

**It keeps asking me to sign in, or signs in as the wrong person.** Ask Claude to log out of the portal, then claim again and sign in in the Chrome window that opens.

**A field was left empty, like the bill number.** The portal may have renamed that field. Ask Claude to run `inspect_claim_form`, and report the field's label so the matching in `browser.js` can be updated.

**Linux: the sign-in window never appears.** Signing in needs a graphical desktop session. A headless server won't work.

## Configuration

Add these under `"env"` in the `nht` entry of Claude Desktop's config. `npm run setup` keeps them when you run it again.

| Variable | Default | What it does |
|---|---|---|
| `NHT_HEADLESS` | `1` | Set to `0` to keep the browser window visible the whole time. Useful for debugging. |
| `NHT_LOGIN_TIMEOUT_MS` | `300000` | How long to wait for you to sign in, in milliseconds. |
| `NHT_PROFILE_DIR` | `~/.nht-mcp/chrome-profile` | Where the browser profile, including your sign-in, is saved. |
| `NHT_BASE_URL` | `https://portal.nighthack.in/` | The portal's address. |

## Development

```sh
npm run build    # rebuild dist/upload.html after editing ui/
```

| File | What's in it |
|---|---|
| `server.js` | The MCP server and its tools |
| `browser.js` | Playwright: sign-in, filling the claim form, submitting |
| `bills.js` | Saving uploads, converting HEIC, rendering bill previews (pdf.js + @napi-rs/canvas) |
| `bill-types.js` | The portal's bill types, used by both the upload box and `claim_bill` |
| `ui/` | The upload box, bundled into `dist/upload.html` by `build.mjs` |
| `scripts/setup.mjs` | Adds the server to, or removes it from, Claude Desktop's config |

| Tool | Who calls it | What it does |
|---|---|---|
| `claim_bills` | Claude | Shows the upload box and checks the sign-in in the background |
| `upload_bill` | The upload box only | Receives and saves a bill file |
| `read_bill` | Claude | Returns an image of the bill (the first page of a PDF) |
| `claim_bill` | Claude | Fills in the claim form and attaches the bill, without submitting |
| `submit_claim` | Claude | Submits the filled-in form |
| `login` / `logout` | Claude | Signs in, or deletes the saved session |
| `inspect_claim_form` | Claude | Lists the form's fields, for fixing field matching |

After changing any `.js` file, quit and reopen Claude Desktop to load the new code.
