// Builds an importable Prism instance zip for every pack in packs/
// and writes the install page to docs/index.html (served by GitHub Pages).
// Usage: node bin/build.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOADER_NAMES, LOADER_UIDS, listPacks, packsDir, readPack, root } from "./lib.mjs";

const OWNER = "hybes";
const REPO = "mc";
const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main`;
const SITE = `https://${OWNER}.github.io/${REPO}`;

const docsDir = path.join(root, "docs");
const bootstrap = path.join(root, "bin", "packwiz.jar");

// Prism names an imported instance after the zip file, so the zip carries the pack's display name.
const zipName = (pack) => `${pack.name.replace(/[\\/:*?"<>|]/g, "").trim()}.zip`;

function buildZip(slug, pack) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pack-"));
  const inst = path.join(tmp, pack.name);
  fs.mkdirSync(path.join(inst, "minecraft"), { recursive: true });
  fs.copyFileSync(bootstrap, path.join(inst, "minecraft", "packwiz.jar"));
  fs.writeFileSync(
    path.join(inst, "instance.cfg"),
    [
      "[General]",
      "ConfigVersion=1.2",
      "InstanceType=OneSix",
      `name=${pack.name}`,
      "iconKey=default",
      "OverrideCommands=true",
      // Prism reads this file as QSettings INI: the whole value must be quoted, with inner quotes escaped.
      `PreLaunchCommand="\\"$INST_JAVA\\" -jar packwiz.jar ${RAW}/packs/${slug}/pack.toml"`,
      "OverrideMemory=true",
      "MinMemAlloc=2048",
      "MaxMemAlloc=6144",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(inst, "mmc-pack.json"),
    JSON.stringify(
      {
        components: [
          { important: true, uid: "net.minecraft", version: pack.mc },
          { uid: LOADER_UIDS[pack.loader], version: pack.loaderVersion },
        ],
        formatVersion: 1,
      },
      null,
      4,
    ),
  );
  const out = path.join(docsDir, zipName(pack));
  fs.rmSync(out, { force: true });
  // -X drops macOS extra attributes so the zip is identical across rebuilds.
  execFileSync("zip", ["-qrX", out, pack.name], { cwd: tmp });
  fs.rmSync(tmp, { recursive: true, force: true });
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function page(packs) {
  const items = packs
    .map(({ slug, pack }) => {
      const file = encodeURIComponent(zipName(pack));
      return `    <li id="${slug}">
      <h2>${esc(pack.name)}</h2>
      <p class="meta">Minecraft ${esc(pack.mc)} · ${LOADER_NAMES[pack.loader]} · ${pack.modCount} mods</p>
      ${pack.description ? `<p>${esc(pack.description)}</p>` : ""}
      <p><a class="install" href="prismlauncher://import?url=${encodeURIComponent(`${SITE}/${file}`)}">Install in Prism</a>
      <a class="alt" href="${file}">Download zip instead</a></p>
    </li>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Minecraft Packs</title>
<style>
  :root { --bg: #f6f5f2; --fg: #1c1c1a; --muted: #66645e; --line: #dcd9d2; --accent: #2f7a3b; --accent-fg: #fff; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1a1a18; --fg: #ecebe7; --muted: #a3a19a; --line: #34332f; --accent: #5cb36a; --accent-fg: #0f1a10; }
  }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 -apple-system, system-ui, sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; }
  h2 { font-size: 1.2rem; margin: 0; }
  a { color: var(--accent); }
  .packs { list-style: none; padding: 0; margin: 24px 0; }
  .packs > li { padding: 20px 0; border-top: 1px solid var(--line); }
  .meta, .lead, footer { color: var(--muted); }
  .meta { margin: 2px 0 8px; font-size: 0.9rem; }
  .install { display: inline-block; background: var(--accent); color: var(--accent-fg); padding: 8px 16px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-right: 12px; }
  .alt { color: var(--muted); font-size: 0.9rem; }
  ol { padding-left: 20px; margin: 8px 0 16px; }
  ol li { margin: 4px 0; }
  footer { font-size: 0.95rem; border-top: 1px solid var(--line); padding-top: 20px; }
  footer h2 { font-size: 1rem; color: var(--fg); }
</style>
</head>
<body>
<main>
  <h1>Minecraft Packs</h1>
  <p class="lead">Click Install, then Yes in Prism. Mods update by themselves every time you press Play. Every pack works with a controller, and the newer ones include WorldEdit and BuildPaste for instant builds.</p>
  <ul class="packs">
${items}
  </ul>
  <footer>
    <h2>First time?</h2>
    <ol>
      <li>Install <a href="https://prismlauncher.org/download/">Prism Launcher</a>.</li>
      <li>In Prism, open Accounts and sign in with the Microsoft account that owns Minecraft Java.</li>
      <li>Come back here and click Install.</li>
    </ol>
    <p>If Install does nothing, use “Download zip instead”, then in Prism choose Add Instance, Import, and pick the zip.</p>
  </footer>
</main>
</body>
</html>
`;
}

fs.mkdirSync(docsDir, { recursive: true });
const packs = listPacks();

for (const { slug, pack } of packs) {
  execFileSync(path.join(os.homedir(), ".local/bin/packwiz"), ["refresh"], { cwd: path.join(packsDir, slug), stdio: "ignore" });
  buildZip(slug, readPack(path.join(packsDir, slug, "pack.toml")));
  console.log(`built ${slug}: ${pack.name} (${pack.modCount} mods)`);
}
// Remove zips for packs that no longer exist.
for (const f of fs.readdirSync(docsDir).filter((f) => f.endsWith(".zip"))) {
  if (!packs.some(({ pack }) => zipName(pack) === f)) fs.rmSync(path.join(docsDir, f));
}
fs.writeFileSync(path.join(docsDir, "index.html"), page(packs));
fs.writeFileSync(path.join(docsDir, ".nojekyll"), "");
console.log(`page: ${SITE}/`);
