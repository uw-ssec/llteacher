#!/usr/bin/env node
/* --------------------------------------------------------------------------
   Materializes webR's release assets (~46MB, 170 files: the JS loader,
   R.wasm, and the R package/library filesystem) into Vite's public dir so
   they get served same-origin, through the same ASSETS binding as every
   other static file this app ships -- see useWebR.ts's own doc comment for
   why self-hosting replaced the CDN load (#368, #369).

   Not committed to git (public/webr/ is gitignored, same reasoning as
   node_modules/ itself not being committed): this script re-materializes it
   from the pinned `webr` npm dependency on every install/dev/build, so the
   copy can never drift from the version in package.json.
   -------------------------------------------------------------------------- */
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..");
const dest = path.join(workspaceRoot, "src", "client", "public", "webr");

/* npm workspaces hoists `webr` to whichever ancestor node_modules actually
   holds it (usually the monorepo root, not apps/web/node_modules) -- walk up
   from this workspace the same way Node's own module resolution would,
   rather than assuming one fixed location. */
function findWebrDist(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", "webr", "dist");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const src = findWebrDist(workspaceRoot);
if (!src) {
  console.error(
    `[copy-webr-assets] could not find node_modules/webr/dist by walking up from ${workspaceRoot} -- is the pinned "webr" dependency installed? Run npm install first.`,
  );
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-webr-assets] copied ${src} -> ${dest}`);
