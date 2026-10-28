#!/usr/bin/env node
// Packs @nexward/sdk exactly as npm would publish it, installs the tarball into an
// empty project with npm (no workspace, no network for dependencies), and checks
// that it imports, has no runtime dependencies, ships only the intended files, and
// enforces its basic contract. Run after `pnpm --filter @nexward/sdk build`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sdkDir = join(import.meta.dirname, "..", "packages", "sdk");
const work = mkdtempSync(join(tmpdir(), "nexward-sdk-pack-"));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const tarball = run("pnpm", ["pack", "--pack-destination", work], sdkDir).trim().split("\n").at(-1);
const listing = run("tar", ["-tzf", tarball], work).split("\n").filter(Boolean).sort();
const allowed = /^package\/(package\.json|README\.md|LICENSE|NOTICE|THIRD_PARTY_NOTICES\.md|dist\/index\.js(\.map)?|dist\/[a-z]+\.d\.ts)$/;
const unexpected = listing.filter((f) => !allowed.test(f));
if (unexpected.length > 0) throw new Error(`unexpected files in package: ${unexpected.join(", ")}`);

const manifest = JSON.parse(run("tar", ["-xzOf", tarball, "package/package.json"], work));
if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) throw new Error("published package must have no runtime dependencies");
if (JSON.stringify(manifest).includes("workspace:")) throw new Error("workspace: protocol leaked into the published manifest");

writeFileSync(join(work, "package.json"), JSON.stringify({ name: "pack-check", private: true, type: "module" }));
run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball], work);
writeFileSync(
  join(work, "check.mjs"),
  `import { Nexward, NexwardConfigError } from "@nexward/sdk";
let threw = false;
try { new Nexward({ apiKey: "not-a-key", baseUrl: "https://api.nexward.ai" }); } catch (e) { threw = e instanceof NexwardConfigError; }
if (!threw) throw new Error("malformed key must be rejected");
const key = "nxw_test_" + "a".repeat(12) + "_" + "B".repeat(43);
const nx = new Nexward({ apiKey: key, baseUrl: "http://127.0.0.1:9", timeouts: { attemptMs: 200, totalMs: 400, maxAttempts: 1 } });
let ran = false;
const out = await nx.protect({ agentId: "support-agent", tool: "email.send", arguments: {} }, () => { ran = true; });
if (ran || out.outcome !== "not_executed" || out.reason !== "NEXWARD_UNAVAILABLE") throw new Error("must fail closed: " + JSON.stringify(out));
console.log("ok");`,
);
const result = run("node", ["check.mjs"], work).trim();
if (result !== "ok") throw new Error(`smoke test failed: ${result}`);
console.log(`@nexward/sdk ${manifest.version}: package contents, zero dependencies, import, and fail-closed smoke test OK (${String(listing.length)} files)`);
