// Build script: bundles each public entry with esbuild and emits type
// declarations with tsc. Run with `bun run build`.
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

rmSync(join(root, "dist"), { recursive: true, force: true });

// Each public entry gets its own self-contained bundle. Bun builtins stay
// external so the runtime resolves them.
const entries = [
  { entryPoints: ["src/index.ts"], outfile: "dist/index.js" },
  { entryPoints: ["src/providers/index.ts"], outfile: "dist/providers.js" },
  { entryPoints: ["src/persistence/index.ts"], outfile: "dist/persistence.js" },
  { entryPoints: ["src/transport/index.ts"], outfile: "dist/transport.js" },
];

for (const options of entries) {
  await build({
    absWorkingDir: root,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "esnext",
    external: ["bun:*"],
    sourcemap: true,
    logLevel: "info",
    ...options,
  });
}

// esbuild does not emit declarations — tsc does. The emitted tree mirrors
// src/ so each entry's `.d.ts` sits next to its bundle in dist/.
execSync("bunx tsc -p tsconfig.build.json", { cwd: root, stdio: "inherit" });

console.log("\nBuild complete:");
for (const { outfile } of entries) {
  console.log(`  dist/${outfile.replace("dist/", "")}`);
}
console.log("  dist/**/*.d.ts (declarations)");
