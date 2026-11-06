// Checks packs for problems that would crash the game, without launching it.
// Downloads every jar (cached in ~/.cache/hybes-mc) and checks:
//  - required dependencies are present and in the version range each mod asks for
//  - no installed mod is declared incompatible by another
//  - mixins that patch another mod's classes still match those classes
//  - no jar needs a newer Java than the pack's Minecraft version uses
// Usage: node bin/check.mjs [pack-slug...]   (no slugs checks every pack)
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { listPacks, packsDir } from "./lib.mjs";

const cacheDir = path.join(os.homedir(), ".cache", "hybes-mc", "jars");

// ---------- zip ----------

function openZip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, { method, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const read = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
    const data = buf.subarray(start, start + e.size);
    return e.method === 0 ? data : zlib.inflateRawSync(data);
  };
  return { names: [...entries.keys()], has: (n) => entries.has(n), read };
}

// ---------- class files ----------

function parseClass(buf) {
  let p = 8;
  const u1 = () => buf[p++];
  const u2 = () => ((p += 2), buf.readUInt16BE(p - 2));
  const u4 = () => ((p += 4), buf.readUInt32BE(p - 4));
  const major = buf.readUInt16BE(6);
  const cpCount = u2();
  const cp = new Array(cpCount);
  for (let i = 1; i < cpCount; i++) {
    const tag = u1();
    if (tag === 1) {
      const len = u2();
      cp[i] = buf.toString("utf8", p, p + len);
      p += len;
    } else if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) cp[i] = { tag, ref: u2() };
    else if (tag === 15) (p += 3);
    else if (tag === 3) cp[i] = buf.readInt32BE((p += 4) - 4);
    else if (tag === 4) cp[i] = buf.readFloatBE((p += 4) - 4);
    else if (tag === 5 || tag === 6) (p += 8), i++;
    else p += 4; // 9,10,11,12,17,18
  }
  const str = (i) => cp[i];
  const readAnnotation = () => {
    const type = str(u2());
    const values = {};
    const n = u2();
    for (let i = 0; i < n; i++) values[str(u2())] = readValue();
    return { type, values };
  };
  const readValue = () => {
    const tag = String.fromCharCode(u1());
    if ("BCDFIJSZs".includes(tag)) return cp[u2()];
    if (tag === "e") return (u2(), str(u2()));
    if (tag === "c") return { cls: str(u2()) };
    if (tag === "@") return readAnnotation();
    if (tag === "[") {
      const n = u2();
      return Array.from({ length: n }, readValue);
    }
    throw new Error(`bad annotation tag ${tag}`);
  };
  const readAttrs = () => {
    const anns = [];
    const n = u2();
    for (let i = 0; i < n; i++) {
      const name = str(u2());
      const len = u4();
      const end = p + len;
      if (name === "RuntimeInvisibleAnnotations" || name === "RuntimeVisibleAnnotations") {
        const k = u2();
        for (let j = 0; j < k; j++) anns.push(readAnnotation());
      }
      p = end;
    }
    return anns;
  };
  u2();
  const thisClass = str(cp[u2()].ref);
  u2();
  const interfaces = u2();
  p += 2 * interfaces;
  const members = () =>
    Array.from({ length: u2() }, () => {
      const access = u2();
      const name = str(u2());
      const desc = str(u2());
      return { access, name, desc, anns: readAttrs() };
    });
  const fields = members();
  const methods = members();
  const anns = readAttrs();
  return { major, name: thisClass, fields, methods, anns };
}

// ---------- mod metadata ----------

// Minimal TOML reader for mods.toml: tables, arrays of tables, and simple key = value lines.
function parseToml(text) {
  const rootObj = {};
  let cur = rootObj;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    let m;
    if ((m = line.match(/^\[\[\s*([^\]]+?)\s*\]\]/))) {
      const keys = m[1].split(".").map((k) => k.replace(/^"|"$/g, ""));
      let o = rootObj;
      for (const k of keys.slice(0, -1)) o = o[k] ??= {};
      const last = keys.at(-1);
      (o[last] ??= []).push((cur = {}));
      continue;
    }
    if ((m = line.match(/^\[\s*([^\]]+?)\s*\]/))) {
      const keys = m[1].split(".").map((k) => k.replace(/^"|"$/g, ""));
      cur = rootObj;
      for (const k of keys) cur = cur[k] ??= {};
      continue;
    }
    if (!(m = line.match(/^("?[\w.-]+"?)\s*=\s*(.*)$/))) continue;
    const key = m[1].replace(/^"|"$/g, "");
    let val = m[2];
    const triple = val.match(/^('''|""")/);
    if (triple) {
      let body = val.slice(3);
      while (!body.includes(triple[1]) && i + 1 < lines.length) body += "\n" + lines[++i];
      cur[key] = body.slice(0, body.indexOf(triple[1]));
      continue;
    }
    if ((m = val.match(/^"((?:[^"\\]|\\.)*)"/))) cur[key] = m[1];
    else if ((m = val.match(/^'([^']*)'/))) cur[key] = m[1];
    else if (/^(true|false)\b/.test(val)) cur[key] = val.startsWith("true");
    else if ((m = val.match(/^-?\d+(\.\d+)?/))) cur[key] = Number(m[0]);
    else if (val.startsWith("[")) {
      while (!val.includes("]") && i + 1 < lines.length) val += lines[++i];
      cur[key] = [...val.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    }
  }
  return rootObj;
}

function manifest(zip) {
  const text = zip.read("META-INF/MANIFEST.MF")?.toString("utf8") ?? "";
  const out = {};
  let last;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(" ") && last) out[last] += line.slice(1);
    else {
      const i = line.indexOf(":");
      if (i > 0) out[(last = line.slice(0, i))] = line.slice(i + 1).trim();
    }
  }
  return out;
}

// Returns { mods: [{id, version, deps}], mixinConfigs, nested: [Buffer] } for one jar.
function readJarMeta(zip, loader) {
  const mf = manifest(zip);
  const mods = [];
  const mixinConfigs = new Set((mf.MixinConfigs ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const nested = [];
  if (loader === "fabric" || loader === "quilt") {
    const raw = zip.read("fabric.mod.json");
    if (raw) {
      const j = JSON.parse(raw.toString("utf8").replace(/^﻿/, "").replace(/[\u0000-\u001f]+/g, " "));
      const deps = [];
      for (const [kind, type] of [["depends", "required"], ["breaks", "incompatible"], ["recommends", "optional"]])
        for (const [id, range] of Object.entries(j[kind] ?? {})) deps.push({ id, type, range, fabric: true });
      mods.push({ id: j.id, version: j.version, deps });
      for (const id of j.provides ?? []) mods.push({ id, version: j.version, deps: [] });
      for (const m of j.mixins ?? []) mixinConfigs.add(typeof m === "string" ? m : m.config);
      for (const n of j.jars ?? []) {
        const b = zip.read(n.file);
        if (b) nested.push(b);
      }
    }
  } else {
    // Multi-loader jars carry both files; Forge only reads mods.toml.
    const raw = (loader === "neoforge" ? zip.read("META-INF/neoforge.mods.toml") : null) ?? zip.read("META-INF/mods.toml");
    if (raw) {
      const t = parseToml(raw.toString("utf8"));
      for (const m of t.mixins ?? []) if (m.config) mixinConfigs.add(m.config);
      for (const mod of t.mods ?? []) {
        let version = String(mod.version ?? "");
        if (version.includes("${file.jarVersion}")) version = mf["Implementation-Version"] ?? "0";
        const deps = (t.dependencies?.[mod.modId] ?? []).map((d) => ({
          id: d.modId,
          type: d.type ?? (d.mandatory === false ? "optional" : "required"),
          range: d.versionRange ?? "*",
          side: d.side ?? "BOTH",
        }));
        mods.push({ id: mod.modId, version, deps });
      }
    }
    const jarjar = zip.read("META-INF/jarjar/metadata.json");
    if (jarjar) {
      for (const j of JSON.parse(jarjar.toString("utf8")).jars ?? []) {
        const b = zip.read(j.path);
        if (b) nested.push(b);
      }
    }
  }
  return { mods, mixinConfigs: [...mixinConfigs], nested };
}

// ---------- versions ----------

function tokens(v) {
  return String(v)
    .toLowerCase()
    .replace(/\+.*$/, "")
    .split(/[.\-_]|(?<=\d)(?=\D)|(?<=\D)(?=\d)/)
    .filter(Boolean)
    .map((t) => (/^\d+$/.test(t) ? Number(t) : t));
}
const QUALIFIERS = ["alpha", "a", "beta", "b", "milestone", "m", "rc", "cr", "pre", "snapshot"];
function cmpVersion(a, b) {
  const x = tokens(a);
  const y = tokens(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === q) continue;
    if (p === undefined) return typeof q === "number" ? (q === 0 ? 0 : -1) : QUALIFIERS.includes(q) ? 1 : -1;
    if (q === undefined) return -cmpVersion(b, a);
    if (typeof p === "number" && typeof q === "number") return p < q ? -1 : 1;
    if (typeof p === "number") return 1;
    if (typeof q === "number") return -1;
    const pi = QUALIFIERS.indexOf(p);
    const qi = QUALIFIERS.indexOf(q);
    if (pi !== qi) return pi < qi ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// Maven version ranges, as used by Forge and NeoForge.
function inMavenRange(version, range) {
  range = String(range).trim();
  if (!range || range === "*") return true;
  if (!/^[[(]/.test(range)) return true; // a bare version is a soft requirement: anything goes
  for (const m of range.matchAll(/([[(])\s*([^,\])]*?)\s*(?:,\s*([^\])]*?)\s*)?([\])])/g)) {
    const [, open, lo, hiRaw, close] = m;
    const single = hiRaw === undefined;
    const hi = single ? lo : hiRaw;
    if (single) {
      if (cmpVersion(version, lo) === 0) return true;
      continue;
    }
    const okLo = !lo || (open === "[" ? cmpVersion(version, lo) >= 0 : cmpVersion(version, lo) > 0);
    const okHi = !hi || (close === "]" ? cmpVersion(version, hi) <= 0 : cmpVersion(version, hi) < 0);
    if (okLo && okHi) return true;
  }
  return false;
}

// Fabric version predicates: "*", ">=1.0 <2", "~1.2", "^1.0", "1.21.x", or an array of alternatives.
function inFabricRange(version, pred) {
  if (Array.isArray(pred)) return pred.length === 0 || pred.some((p) => inFabricRange(version, p));
  return String(pred)
    .trim()
    .split(/\s+/)
    .every((part) => {
      if (!part || part === "*") return true;
      const m = part.match(/^(>=|<=|>|<|=|~|\^)?(.+)$/);
      const op = m[1] ?? "=";
      const v = m[2];
      if (/[xX*]/.test(v)) {
        const prefix = v.split(/\.[xX*]/)[0];
        return String(version) === prefix || String(version).startsWith(prefix + ".");
      }
      const c = cmpVersion(version, v);
      const nums = tokens(v);
      if (op === ">=") return c >= 0;
      if (op === "<=") return c <= 0;
      if (op === ">") return c > 0;
      if (op === "<") return c < 0;
      if (op === "~") return c >= 0 && cmpVersion(version, `${nums[0]}.${(nums[1] ?? 0) + 1}`) < 0;
      if (op === "^") return c >= 0 && cmpVersion(version, `${(nums[0] ?? 0) + 1}`) < 0;
      return c === 0;
    });
}

// ---------- downloads ----------

function readPwToml(file) {
  const text = fs.readFileSync(file, "utf8");
  const get = (k) => text.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
  const fileId = text.match(/^file-id\s*=\s*(\d+)/m)?.[1];
  const filename = get("filename");
  let url = get("url");
  if (!url && fileId) url = `https://mediafilez.forgecdn.net/files/${Math.floor(fileId / 1000)}/${fileId % 1000}/${encodeURIComponent(filename)}`;
  return { name: get("name"), filename, url, side: get("side") ?? "both", hashFormat: get("hash-format"), hash: get("hash") };
}

async function fetchJar(meta) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `${meta.hash}-${meta.filename}`);
  if (!fs.existsSync(file)) {
    const res = await fetch(meta.url, { headers: { "User-Agent": "hybes/mc-packs" } });
    if (!res.ok) throw new Error(`download failed (${res.status}) ${meta.url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const algo = { sha1: "sha1", sha256: "sha256", sha512: "sha512", md5: "md5" }[meta.hashFormat];
    if (algo && crypto.createHash(algo).update(buf).digest("hex") !== meta.hash) throw new Error(`hash mismatch for ${meta.filename}`);
    fs.writeFileSync(file, buf);
  }
  return fs.readFileSync(file);
}

// ---------- mixins ----------

const INJECTORS = new Set(
  [
    "org/spongepowered/asm/mixin/injection/Inject",
    "org/spongepowered/asm/mixin/injection/Redirect",
    "org/spongepowered/asm/mixin/injection/ModifyArg",
    "org/spongepowered/asm/mixin/injection/ModifyArgs",
    "org/spongepowered/asm/mixin/injection/ModifyVariable",
    "org/spongepowered/asm/mixin/injection/ModifyConstant",
    "com/llamalad7/mixinextras/injector/wrapoperation/WrapOperation",
    "com/llamalad7/mixinextras/injector/wrapmethod/WrapMethod",
    "com/llamalad7/mixinextras/injector/ModifyExpressionValue",
    "com/llamalad7/mixinextras/injector/ModifyReturnValue",
    "com/llamalad7/mixinextras/injector/v2/WrapWithCondition",
    "com/llamalad7/mixinextras/injector/WrapWithCondition",
    "com/llamalad7/mixinextras/injector/ModifyReceiver",
  ].map((t) => `L${t};`),
);
const ann = (list, short) => list.find((a) => a.type === `Lorg/spongepowered/asm/mixin/${short};` || a.type === `Lorg/spongepowered/asm/mixin/gen/${short};`);
const arr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function accessorName(method, prefixes) {
  const m = method.name.match(new RegExp(`^(${prefixes})([A-Z].*)$`));
  if (!m) return method.name;
  const rest = m[2];
  return /^[A-Z0-9_]+$/.test(rest) ? rest : rest[0].toLowerCase() + rest.slice(1);
}

// Checks one mixin class against a target class from another mod. Returns problems.
function checkMixin(mixin, target) {
  const problems = [];
  const hasField = (name, desc) => target.fields.some((f) => f.name === name && (!desc || f.desc === desc));
  const hasMethod = (name, desc) => target.methods.some((m) => m.name === name && (!desc || m.desc === desc));
  for (const f of mixin.fields) {
    const shadow = ann(f.anns, "Shadow");
    if (!shadow) continue;
    const prefix = shadow.values.prefix ?? "shadow$";
    const name = f.name.startsWith(prefix) ? f.name.slice(prefix.length) : f.name;
    const aliases = arr(shadow.values.aliases);
    if (!hasField(name, f.desc) && !aliases.some((a) => hasField(a, f.desc))) problems.push(`@Shadow field ${name} ${f.desc}`);
  }
  for (const m of mixin.methods) {
    const accessor = ann(m.anns, "Accessor");
    if (accessor) {
      const name = accessor.values.value || accessorName(m, "get|is|set");
      const ret = m.desc.slice(m.desc.indexOf(")") + 1);
      const desc = ret === "V" ? m.desc.slice(1, m.desc.indexOf(")")).replace(/^L[^;]+;(?=.)/, "") : ret;
      if (!hasField(name, desc)) problems.push(`@Accessor ${name} ${desc}`);
      continue;
    }
    const invoker = ann(m.anns, "Invoker");
    if (invoker) {
      const name = invoker.values.value || accessorName(m, "call|invoke|new|create");
      if (name === "<init>" || /^(new|create)/.test(m.name)) continue;
      if (!hasMethod(name, m.desc)) problems.push(`@Invoker ${name}${m.desc}`);
      continue;
    }
    const shadow = ann(m.anns, "Shadow");
    if (shadow) {
      const prefix = shadow.values.prefix ?? "shadow$";
      const name = m.name.startsWith(prefix) ? m.name.slice(prefix.length) : m.name;
      if (!hasMethod(name, m.desc) && !arr(shadow.values.aliases).some((a) => hasMethod(a, m.desc))) problems.push(`@Shadow method ${name}${m.desc}`);
      continue;
    }
    for (const a of m.anns) {
      if (!INJECTORS.has(a.type)) continue;
      const require = a.values.require;
      if (require === 0) continue;
      for (const sel of arr(a.values.method)) {
        if (typeof sel !== "string" || /[*^$\\{}]|^\//.test(sel)) continue;
        const s = sel.replace(/^L[^;]+;/, "");
        const paren = s.indexOf("(");
        const name = paren < 0 ? s : s.slice(0, paren);
        const desc = paren < 0 ? null : s.slice(paren);
        if (!hasMethod(name, desc)) problems.push(`@${a.type.split("/").at(-1).slice(0, -1)} into ${sel}`);
      }
    }
  }
  return problems;
}

// ---------- check one pack ----------

// Java each Minecraft version ships with: 1.18 to 1.20.4 use 17, 1.20.5 to 1.21.x use 21, 26.x uses 25.
function JAVA_FOR_MC(mc) {
  if (!mc.startsWith("1.")) return 25;
  if (/^1\.(1[89]|20)(\.|$)/.test(mc) && !/^1\.20\.([5-9]|\d\d)/.test(mc)) return 17;
  return 21;
}
const MAX_CLASS_VERSION = (java) => java + 44;

async function checkPack(slug, pack) {
  const errors = [];
  const warnings = [];
  const dir = path.join(packsDir, slug, "mods");
  const metas = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(".pw.toml")).map((f) => readPwToml(path.join(dir, f)))
    : [];
  const jars = [];
  for (const meta of metas) {
    if (meta.side === "server") continue;
    try {
      const zip = openZip(await fetchJar(meta));
      jars.push({ label: meta.filename, zip, top: true });
    } catch (e) {
      errors.push(`${meta.filename}: ${e.message}`);
    }
  }
  // Expand nested jars (jar-in-jar libraries).
  for (let i = 0; i < jars.length; i++) {
    jars[i].meta = readJarMeta(jars[i].zip, pack.loader);
    for (const b of jars[i].meta.nested) {
      try {
        jars.push({ label: `${jars[i].label} (bundled)`, zip: openZip(b), top: false });
      } catch {}
    }
  }

  // Mods present (highest version wins, as the loaders do for bundled copies).
  const present = new Map();
  const builtins = {
    minecraft: pack.mc,
    java: String(JAVA_FOR_MC(pack.mc)),
    [pack.loader]: pack.loaderVersion,
    ...(pack.loader === "neoforge" ? { fml: pack.loaderVersion } : {}),
    ...(pack.loader === "forge" ? { fml: pack.loaderVersion } : {}),
    ...(pack.loader === "fabric" ? { fabricloader: pack.loaderVersion } : {}),
  };
  for (const [id, version] of Object.entries(builtins)) present.set(id, { version, label: "(built in)" });
  const topIds = new Map();
  for (const j of jars) {
    for (const mod of j.meta.mods) {
      const prev = present.get(mod.id);
      if (j.top && topIds.has(mod.id) && topIds.get(mod.id) !== j.label) errors.push(`mod id "${mod.id}" is in two jars: ${topIds.get(mod.id)} and ${j.label}`);
      if (j.top) topIds.set(mod.id, j.label);
      if (!prev || (prev.label !== "(built in)" && cmpVersion(mod.version, prev.version) > 0)) present.set(mod.id, { version: mod.version, label: j.label });
    }
  }

  // Dependencies.
  const inRange = pack.loader === "fabric" || pack.loader === "quilt" ? inFabricRange : inMavenRange;
  for (const j of jars) {
    for (const mod of j.meta.mods) {
      if (present.get(mod.id)?.label !== j.label) continue; // a lower bundled copy that is not loaded
      for (const d of mod.deps) {
        if (d.side && d.side.toUpperCase() === "SERVER") continue;
        const have = present.get(d.id);
        const type = String(d.type).toLowerCase();
        if (type === "required") {
          if (!have) errors.push(`${mod.id} needs ${d.id} ${d.range}, which is missing`);
          else if (!inRange(have.version, d.range)) {
            // Many 1.21.1 mods (JEI included) declare minecraft [1.21,1.21.1) and load fine, so only warn.
            (d.id === "minecraft" ? warnings : errors).push(`${mod.id} needs ${d.id} ${d.range}, but ${have.version} is installed`);
          }
        } else if (type === "optional") {
          if (have && !inRange(have.version, d.range)) errors.push(`${mod.id} works with ${d.id} ${d.range} only, but ${have.version} is installed`);
        } else if (type === "incompatible") {
          if (have && inRange(have.version, d.range)) errors.push(`${mod.id} is incompatible with ${d.id} ${have.version}`);
        } else if (type === "discouraged") {
          if (have && inRange(have.version, d.range)) warnings.push(`${mod.id} discourages ${d.id} ${have.version}`);
        }
      }
    }
  }

  // Index every class to the jar that provides it.
  const classOwner = new Map();
  for (const j of jars) for (const n of j.zip.names) if (n.endsWith(".class") && !n.startsWith("META-INF/")) classOwner.set(n.slice(0, -6), j);

  // Java version.
  const maxMajor = MAX_CLASS_VERSION(JAVA_FOR_MC(pack.mc));
  for (const j of jars) {
    const tooNew = j.zip.names.find((n) => n.endsWith(".class") && !n.startsWith("META-INF/") && j.zip.read(n).readUInt16BE(6) > maxMajor);
    if (tooNew) errors.push(`${j.label} needs Java ${j.zip.read(tooNew).readUInt16BE(6) - 44}; this pack runs Java ${JAVA_FOR_MC(pack.mc)}`);
  }

  // Mixins into other mods' classes.
  const parsed = new Map();
  const getClass = (name) => {
    if (!parsed.has(name)) {
      const owner = classOwner.get(name);
      parsed.set(name, owner ? { owner, cls: parseClass(owner.zip.read(`${name}.class`)) } : null);
    }
    return parsed.get(name);
  };
  for (const j of jars) {
    for (const cfgName of j.meta.mixinConfigs) {
      const raw = j.zip.read(cfgName);
      if (!raw) continue; // declared for another loader or bundled elsewhere
      let cfg;
      try {
        cfg = JSON.parse(raw.toString("utf8"));
      } catch {
        warnings.push(`${j.label}: could not read ${cfgName}`);
        continue;
      }
      const pkg = (cfg.package ?? "").replace(/\./g, "/");
      for (const short of [...arr(cfg.mixins), ...arr(cfg.client)]) {
        const name = `${pkg}/${short.replace(/\./g, "/")}`;
        const buf = j.zip.read(`${name}.class`);
        if (!buf) continue;
        let mixin;
        try {
          mixin = parseClass(buf);
        } catch (e) {
          warnings.push(`${j.label}: could not parse ${name}: ${e.message}`);
          continue;
        }
        const m = ann(mixin.anns, "Mixin");
        if (!m) continue;
        const targets = [
          ...arr(m.values.value).map((v) => v.cls?.replace(/^L|;$/g, "")),
          ...arr(m.values.targets).map((t) => String(t).replace(/\./g, "/")),
        ].filter(Boolean);
        for (const t of targets) {
          if (/^(net\/minecraft|com\/mojang|net\/neoforged|net\/minecraftforge|net\/fabricmc|java|javax|sun|jdk)\//.test(t)) continue;
          const found = getClass(t);
          if (!found || found.owner.zip === j.zip) continue;
          for (const p of checkMixin(mixin, found.cls)) {
            // Configs marked "required": false log the failure and carry on instead of crashing.
            (cfg.required === false ? warnings : errors).push(`${j.label} patches ${t.split("/").at(-1)} in ${found.owner.label}, but it has no ${p} (${cfgName}: ${short})`);
          }
        }
      }
    }
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)], jarCount: jars.length };
}

// ---------- main ----------

const wanted = process.argv.slice(2);
const packs = listPacks().filter(({ slug }) => !wanted.length || wanted.includes(slug));
if (wanted.length && packs.length !== wanted.length) {
  console.error(`Unknown pack. Packs: ${listPacks().map((p) => p.slug).join(", ")}`);
  process.exit(1);
}
let failed = false;
for (const { slug, pack } of packs) {
  const { errors, warnings, jarCount } = await checkPack(slug, pack);
  console.log(`${errors.length ? "FAIL" : "ok  "} ${slug}: ${pack.name} (${jarCount} jars, Minecraft ${pack.mc} ${pack.loader} ${pack.loaderVersion})`);
  for (const e of errors) console.log(`  error: ${e}`);
  for (const w of warnings) console.log(`  warning: ${w}`);
  if (errors.length) failed = true;
}
process.exit(failed ? 1 : 0);
