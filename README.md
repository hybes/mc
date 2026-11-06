# Minecraft Packs

Modpacks for Prism Launcher, synced with [packwiz](https://packwiz.infra.link/).

**Install page:** https://hybes.github.io/mc/

Each pack in `packs/` is installed once from the install page. After that, Prism runs packwiz-installer before every launch, so anything pushed here reaches every player the next time they press Play.

## Changing a pack

```sh
cd packs/<pack>
packwiz mr install <modrinth-slug>   # or: packwiz cf install <curseforge-slug>
packwiz remove <mod>
cd ../.. && node bin/check.mjs <pack> && node bin/build.mjs && git add -A && git commit -m "..." && git push
```

`bin/check.mjs` downloads every jar and fails on missing or out-of-range dependencies, incompatible mods, mixins that no longer match another mod's classes (the cause of the Controllable/JEI crash), and jars that need a newer Java. It does not launch the game. JEI is pinned in Portals and Sodium in the 1.21.1 packs for this reason; run the check before unpinning.

Removing a mod deletes its blocks, items and dimensions from existing worlds. Back up the world first.

## New pack

```sh
node bin/new.mjs <slug> "<Name>" <minecraft-version> <forge|neoforge|fabric|quilt>
```

Add mods, run `node bin/build.mjs`, then commit and push. The pack appears on the install page.

Changing a pack's Minecraft or loader version means everyone reinstalls it from the page.
