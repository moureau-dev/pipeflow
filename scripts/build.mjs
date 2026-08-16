// Build script: transpiles every source module to ESM + CJS and emits type
// declarations. Run with `bun run build`.
//
// Source imports are extensionless; the emitted artifacts get explicit `.js`
// specifiers (required for Node ESM and node16/nodenext type resolution).
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Glob } from "bun";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

rmSync(join(root, "dist"), { recursive: true, force: true });

// Relative import specifiers, to be given explicit `.js` extensions.
// Covers `from "./x"`, `import("./x")`, `require("./x")`, and the bare
// side-effect form `import "./x"` that esbuild emits when it elides
// type-only named imports.
const specifierPattern =
  /((?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s*)["'])(\.{1,2}\/[^"']*?)(["'])/g;

// Every source file (except tests) is transpiled individually, mirroring the
// src/ tree, so any module is importable through the subpath exports.
const glob = new Glob("**/*.ts");
const scanned = await Array.fromAsync(glob.scan({ cwd: srcDir }));
const entryPoints = scanned
  .filter((file) => !file.endsWith(".test.ts") && !file.includes("contract-tests"))
  .map((file) => join(srcDir, file));

const shared = {
  entryPoints,
  outbase: srcDir,
  platform: "neutral",
  target: "esnext",
  sourcemap: true,
  minify: true,
};

await Promise.all([
  build({ ...shared, format: "esm", outdir: join(root, "dist/esm") }),
  build({ ...shared, format: "cjs", outdir: join(root, "dist/cjs") }),
]);

// The root package declares `"type": "module"`, so the CJS tree needs its
// own marker to be treated as CommonJS by Node.
mkdirSync(join(root, "dist/cjs"), { recursive: true });
writeFileSync(
  join(root, "dist/cjs/package.json"),
  JSON.stringify({ type: "commonjs" }, null, 2) + "\n",
);

// esbuild does not emit declarations — tsc does.
execSync("bunx tsc -p tsconfig.build.json", { cwd: root, stdio: "inherit" });

// Give relative imports explicit `.js` specifiers in the emitted output.
fixRelativeSpecifiers(join(root, "dist/esm"));
fixRelativeSpecifiers(join(root, "dist/cjs"));
fixRelativeSpecifiers(join(root, "dist/types"));

console.log(`\nBuild complete: ${entryPoints.length} modules → dist/esm, dist/cjs, dist/types`);

function fixRelativeSpecifiers(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      fixRelativeSpecifiers(path);
    } else if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) {
      const original = readFileSync(path, "utf8");
      const updated = original.replace(specifierPattern, (match, prefix, specifier, quote) => {
        // Leave specifiers that already carry an extension untouched.
        if (/\.(js|ts|mjs|cjs)$/.test(specifier)) return match;
        return `${prefix}${specifier}.js${quote}`;
      });
      if (updated !== original) {
        writeFileSync(path, updated);
      }
    }
  }
}
