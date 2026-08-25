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
 * Only Node built-ins and node-fetch are left external (`node:*`, `node-fetch`).
 * openai, @anthropic-ai/sdk, googleapis subpaths, google-auth-library, and dotenv
 * are all bundled in.
 *
 * WHY node-fetch is external: node-fetch (a CJS dep of google-auth-library/gaxios)
 * does dynamic require() of builtins (e.g. require('stream')) that esbuild cannot
 * bundle into ESM output — the ESM bundle would crash with "Dynamic require of
 * ... is not supported". Leaving it external + vendoring its small dep tree into
 * dist/node_modules lets Node's own CJS loader handle it. Everything else
 * (including all of googleapis except the Gmail/Drive clients we import) is
 * tree-shaken away by the bundle.
 */
import esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "fs";
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

// Vendor the externalized CJS packages + their runtime dep trees into
// dist/node_modules so the packaged app ships nothing else from node_modules
// (electron-builder copies dist/** only). agentkeepalive (from @anthropic-ai/sdk)
// is standalone; node-fetch brings the small whatwg-url tree.
const VENDOR = ["node-fetch", "whatwg-url", "tr46", "webidl-conversions", "agentkeepalive"];
const vendorDir = join("dist", "node_modules");
rmSync(vendorDir, { recursive: true, force: true });
mkdirSync(vendorDir, { recursive: true });
for (const pkg of VENDOR) {
  cpSync(join("node_modules", pkg), join(vendorDir, pkg), { recursive: true });
}

