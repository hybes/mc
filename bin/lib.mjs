// Shared helpers for the build and check scripts.
import fs from "node:fs";
import path from "node:path";

export const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const packsDir = path.join(root, "packs");

export const LOADER_UIDS = {
  forge: "net.minecraftforge",
  neoforge: "net.neoforged",
  fabric: "net.fabricmc.fabric-loader",
  quilt: "org.quiltmc.quilt-loader",
};
export const LOADER_NAMES = { forge: "Forge", neoforge: "NeoForge", fabric: "Fabric", quilt: "Quilt" };

// Reads the few values we need from pack.toml without a TOML dependency.
export function readPack(file) {
  const text = fs.readFileSync(file, "utf8");
  const get = (key) => text.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
  const versions = text.split(/^\[versions\]\s*$/m)[1] ?? "";
  const loaders = Object.keys(LOADER_UIDS)
    .map((l) => [l, versions.match(new RegExp(`^${l}\\s*=\\s*"([^"]*)"`, "m"))?.[1]])
    .filter(([, v]) => v);
  if (loaders.length !== 1) throw new Error(`${file}: expected exactly one mod loader`);
  const mc = versions.match(/^minecraft\s*=\s*"([^"]*)"/m)?.[1];
  if (!mc) throw new Error(`${file}: missing minecraft version`);
  return {
    name: get("name"),
    description: get("description") ?? "",
    version: get("version") ?? "",
    mc,
    loader: loaders[0][0],
    loaderVersion: loaders[0][1],
    modCount: fs.existsSync(path.join(path.dirname(file), "mods"))
      ? fs.readdirSync(path.join(path.dirname(file), "mods")).filter((f) => f.endsWith(".toml")).length
      : 0,
  };
}

// Every pack in packs/, sorted by slug.
export function listPacks() {
  return fs
    .readdirSync(packsDir)
    .filter((slug) => fs.existsSync(path.join(packsDir, slug, "pack.toml")))
    .sort()
    .map((slug) => ({ slug, pack: readPack(path.join(packsDir, slug, "pack.toml")) }));
}
