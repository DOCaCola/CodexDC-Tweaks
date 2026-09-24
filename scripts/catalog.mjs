import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const commit = process.env.CATALOG_COMMIT ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Catalog requires a complete source commit SHA");
const ids = new Set();
const entries = readdirSync("tweaks", { withFileTypes: true }).filter((d) => d.isDirectory()).map((dir) => {
  const path = `tweaks/${dir.name}`;
  const manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
  if (!manifest.id || !manifest.version || !manifest.name || ids.has(manifest.id)) throw new Error(`Invalid/duplicate manifest in ${path}`);
  ids.add(manifest.id);
  if (manifest.githubRepo !== "DOCaCola/CodexDC-Tweaks") throw new Error("Incorrect manifest repository");
  if (!/^[a-zA-Z0-9_.-]+$/.test(manifest.main)) throw new Error("Invalid tweak entrypoint");
  readFileSync(join(path, manifest.main));
  return { id: manifest.id, manifest, repo: manifest.githubRepo, path, approvedCommitSha: commit,
    approvedAt: new Date().toISOString(), approvedBy: "DOCaCola",
    platforms: dir.name === "shell-display-fixes" ? ["win32"] : ["win32", "darwin"],
    releaseUrl: `https://github.com/DOCaCola/CodexDC-Tweaks/tree/${commit}/${path}` };
});
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.json", JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), entries }, null, 2) + "\n");
console.log(`Catalog: ${entries.length} tweaks pinned to ${commit}`);
