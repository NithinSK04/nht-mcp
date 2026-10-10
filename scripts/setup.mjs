#!/usr/bin/env node
// Adds (or with --remove, removes) the "nht" server in Claude Desktop's config.
// Uses absolute paths for node and server.js, because Claude Desktop doesn't
// see your shell's PATH. Safe to re-run; backs up the config first.
//
//   npm run setup                         add / update
//   npm run setup -- --remove             remove
//   npm run setup -- --config <file>      use a different config file
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const NAME = "nht";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const remove = argv.includes("--remove");
const configArg = argv.includes("--config") ? argv[argv.indexOf("--config") + 1] : null;

const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

// Where Claude Desktop keeps its config on each platform. Claude Desktop has
// no official Linux build; community builds use ~/.config/Claude.
function defaultConfigPath() {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude", "claude_desktop_config.json");
  }
}

// Prefer a stable symlink (e.g. /opt/homebrew/bin/node) over the versioned
// path in process.execPath, so upgrading Node doesn't break the config.
function nodePath() {
  if (process.platform === "win32") return process.execPath;
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
    try {
      if (fs.realpathSync(candidate) === fs.realpathSync(process.execPath)) return candidate;
    } catch {}
  }
  return process.execPath;
}

// The server drives Google Chrome if it's installed, else Playwright's Chromium.
async function checkBrowser() {
  try {
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    await browser.close();
    return "Google Chrome";
  } catch {}
  if (fs.existsSync(chromium.executablePath())) return "Playwright Chromium";
  return null;
}

const CONFIG = path.resolve(configArg || defaultConfigPath());

let config = {};
if (fs.existsSync(CONFIG)) {
  const raw = fs.readFileSync(CONFIG, "utf8");
  try {
    config = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    die(`${CONFIG} isn't valid JSON (${err.message}). Fix it, then run this again.`);
  }
  fs.copyFileSync(CONFIG, `${CONFIG}.bak`);
}

config.mcpServers ??= {};
if (remove) {
  if (!config.mcpServers[NAME]) die(`No "${NAME}" server in ${CONFIG}; nothing to remove.`);
  delete config.mcpServers[NAME];
} else {
  if (!fs.existsSync(path.join(ROOT, "dist", "upload.html"))) die("dist/upload.html is missing. Run `npm install` first.");
  const env = config.mcpServers[NAME]?.env; // keep any NHT_* settings you added
  config.mcpServers[NAME] = { command: nodePath(), args: [path.join(ROOT, "server.js")], ...(env && { env }) };
}

fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
fs.writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);

if (remove) {
  console.log(`✓ Removed "${NAME}" from ${CONFIG}`);
} else {
  const { command, args } = config.mcpServers[NAME];
  console.log(`✓ Added "${NAME}" to ${CONFIG}`);
  console.log(`  ${command} ${args[0]}`);
  const browser = await checkBrowser();
  if (browser) {
    console.log(`✓ Browser: ${browser}`);
  } else {
    console.log("\n! No browser found. Install Google Chrome, or run: npx playwright install chromium");
    if (process.platform === "linux") console.log("  (on Linux: npx playwright install --with-deps chromium)");
  }
}
console.log("\nNow quit Claude Desktop completely and open it again.");
