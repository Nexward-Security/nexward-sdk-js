// Builds the published package: one self-contained ES module (the wire-contract
// schemas and zod are bundled in, so customers install no runtime dependencies,
// threat model T31) plus type declarations emitted by tsc.
import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
execFileSync("tsc", ["-p", "tsconfig.build.json", "--emitDeclarationOnly"], { stdio: "inherit" });
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  minify: true,
  sourcemap: true,
  sourcesContent: false,
  legalComments: "eof", // keeps the bundled zod license notice
  logLevel: "warning",
});
