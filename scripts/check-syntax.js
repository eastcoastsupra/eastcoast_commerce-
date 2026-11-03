import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

async function listJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listJavaScriptFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(path);
    }
  }
  return files;
}

const files = [
  ...(await listJavaScriptFiles("src")),
  ...(await listJavaScriptFiles("scripts")),
  ...(await listJavaScriptFiles("test"))
];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
  console.log(`Syntax check passed for ${files.length} JavaScript files.`);
}
