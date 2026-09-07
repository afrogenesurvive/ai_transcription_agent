/**
 * agent-runner build — bundles index.js into a single self-contained ESM file.
 *
 * Why: electron-builder ships agent-runner as an extraResource. Previously that
 * meant copying the ENTIRE node_modules tree (googleapis alone carries all ~250
 * Google API clients). Bundling with esbuild + subpath googleapis imports
 * (tool-executor.js) collapses the runtime into dist/bundle.js — typically a
 * few MB vs. 100-200 MB of node_modules, and it starts faster too.
 *
 * Usage:
 *   npm run build        # after `npm ci`
 *   node dist/bundle.js  # runs exactly like `node index.js`
 *
 * Only Node built-ins, node-fetch, and agentkeepalive are left external
 * (`node:*`, `node-fetch`, `agentkeepalive`). openai, @anthropic-ai/sdk,
 * googleapis subpaths, google-auth-library, and dotenv are all bundled in.
 *
 * WHY node-fetch + agentkeepalive are external: node-fetch (a CJS dep of
 * google-auth-library/gaxios) and agentkeepalive (from @anthropic-ai/sdk) are
 * CJS modules esbuild can't safely fold into ESM output (e.g. dynamic
 * require() of builtins — the ESM bundle would crash with "Dynamic require of
 * ... is not supported"). Leaving them external + vendoring each one AND its
 * full transitive dependency closure into dist/node_modules lets Node's own
 * CJS loader resolve them at runtime. Everything else (including all of
 * googleapis except the Gmail/Drive clients we import) is tree-shaken away by
 * the bundle.
 */
import esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";

await esbuild.build({
  entryPoints: ["index.js"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile: "dist/bundle.js",
  sourcemap: false,
  // node:* stays external; node-fetch + agentkeepalive stay external (see comment above).
  external: ["node:*", "node-fetch", "agentkeepalive"],
  logLevel: "info",
});

// Vendor the externalized CJS packages + their FULL transitive dependency
// closure into dist/node_modules so the packaged app ships nothing else from
// node_modules (electron-builder copies dist/** only).
//
// The closure is computed from each package's package.json "dependencies", NOT
// a hand-maintained list — agentkeepalive (from @anthropic-ai/sdk) requires
// 'humanize-ms', which requires 'ms'. Shipping only the top-level package made
// the packaged runner crash at startup with "Cannot find module 'humanize-ms'"
// (MODULE_NOT_FOUND) the instant agentkeepalive was loaded. Resolving the
// closure automatically prevents that class of bug when dependencies change.
const VENDOR_ROOTS = ["node-fetch", "whatwg-url", "tr46", "webidl-conversions", "agentkeepalive"];

/** Compute the transitive dependency closure of `roots` among the packages
 *  installed in ./node_modules. npm ci hoists these to the top level, so each
 *  dependency of a vendored package lives at ./node_modules/<dep>. Packages
 *  that aren't actually installed (e.g. an unselected optional dep) are
 *  skipped rather than erroring. */
function collectClosure(roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const pkgJsonPath = join("node_modules", name, "package.json");
    if (!existsSync(pkgJsonPath)) continue; // not installed → nothing to resolve
    seen.add(name);
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      for (const dep of Object.keys(pkg.dependencies || {})) queue.push(dep);
    } catch (err) {
      console.warn(`[build] Could not read deps for vendored package ${name}: ${err.message}`);
    }
  }
  return [...seen];
}

const VENDOR = collectClosure(VENDOR_ROOTS);
const vendorDir = join("dist", "node_modules");
rmSync(vendorDir, { recursive: true, force: true });
mkdirSync(vendorDir, { recursive: true });
for (const pkg of VENDOR) {
  const src = join("node_modules", pkg);
  if (!existsSync(src)) {
    console.warn(`[build] Skipping vendored package (not installed): ${pkg}`);
    continue;
  }
  cpSync(src, join(vendorDir, pkg), { recursive: true });
}
console.log(`[build] Vendored ${VENDOR.length} externalized packages into dist/node_modules: ${VENDOR.join(", ")}`);

