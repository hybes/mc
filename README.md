# Minecraft Packs

Modpacks for Prism Launcher, synced with [packwiz](https://packwiz.infra.link/).

**Install page:** https://hybes.github.io/mc/

Each pack in `packs/` is installed once from the install page. After that, Prism runs packwiz-installer before every launch, so anything pushed here reaches every player the next time they press Play.

## Changing a pack

```sh
cd packs/<pack>
packwiz mr install <modrinth-slug>   # or: packwiz cf install <curseforge-slug>
packwiz remove <mod>
cd ../.. && node bin/build.mjs && git add -A && git commit -m "..." && git push
```

Removing a mod deletes its blocks, items and dimensions from existing worlds. Back up the world first.

## New pack

```sh
node bin/new.mjs <slug> "<Name>" <minecraft-version> <forge|neoforge|fabric|quilt>
```

Add mods, run `node bin/build.mjs`, then commit and push. The pack appears on the install page.

Changing a pack's Minecraft or loader version means everyone reinstalls it from the page.
