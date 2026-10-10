// Bundles ui/upload.js and inlines it into dist/upload.html — MCP App views
// render in a sandboxed iframe, so the page must be self-contained.
import { build } from "esbuild";
import fs from "node:fs";

const { outputFiles } = await build({
  entryPoints: ["ui/upload.js"],
  bundle: true,
  format: "esm",
  minify: true,
  write: false,
  target: "es2022",
});
const js = outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = fs.readFileSync("ui/upload.html", "utf8").replace("/*__BUNDLE__*/", () => js);
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/upload.html", html);
console.log(`dist/upload.html ${(html.length / 1024).toFixed(0)} KB`);
