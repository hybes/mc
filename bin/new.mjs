// Creates a new empty pack in packs/<slug>.
// Usage: node bin/new.mjs <slug> "<Name>" <minecraft-version> <forge|neoforge|fabric|quilt>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [slug, name, mc, loader] = process.argv.slice(2);
if (!slug || !name || !mc || !["forge", "neoforge", "fabric", "quilt"].includes(loader)) {
  console.error('Usage: node bin/new.mjs <slug> "<Name>" <minecraft-version> <forge|neoforge|fabric|quilt>');
  process.exit(1);
}
if (!/^[a-z0-9-]+$/.test(slug)) {
  console.error("Slug must be lowercase letters, numbers and dashes.");
  process.exit(1);
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dir = path.join(root, "packs", slug);
if (fs.existsSync(dir)) {
  console.error(`packs/${slug} already exists.`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });

const packwiz = path.join(os.homedir(), ".local/bin/packwiz");
execFileSync(
  packwiz,
  ["init", "--name", name, "--author", "hybes", "--version", "1.0.0", "--mc-version", mc, "--modloader", loader, `--${loader}-latest`],
  { cwd: dir, stdio: "inherit" },
);
// e4mc lets players join over the internet with no port forwarding.
execFileSync(packwiz, ["mr", "install", "-y", "e4mc"], { cwd: dir, stdio: "inherit" });
console.log(`\nCreated packs/${slug}. Add mods with: cd packs/${slug} && packwiz mr install <mod>`);
console.log("Then run: node bin/build.mjs, commit and push.");
