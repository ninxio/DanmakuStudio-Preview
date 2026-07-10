import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const roots = ["src", "src-tauri/src", "tests", "scripts", "README.md"];
const ignoredDirectories = new Set(["node_modules", "dist", "target", "gen", ".git", "test-results"]);
const textExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".rs"]);
const typeScriptExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);

const checks = [
  {
    name: "待办标记",
    pattern: new RegExp(`\\b(?:${["TO" + "DO", "FIX" + "ME"].join("|")})\\b|${"未" + "实现"}`, "g")
  }
];

const typeScriptChecks = [
  {
    name: "裸 any",
    pattern: /\bany\b/g
  }
];

const findings = [];

for (const root of roots) {
  scanPath(root);
}

if (findings.length > 0) {
  console.error("源码审计发现需要复核的内容：");
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line}:${finding.column} [${finding.name}] ${finding.text}`);
  }
  process.exit(1);
}

console.log("源码审计通过：未发现待办标记或 TypeScript 裸 any。");

function scanPath(path) {
  const stats = statSync(path);
  if (stats.isDirectory()) {
    const name = path.split(/[\\/]/).at(-1) ?? path;
    if (ignoredDirectories.has(name)) {
      return;
    }
    for (const entry of readdirSync(path)) {
      scanPath(join(path, entry));
    }
    return;
  }
  if (!stats.isFile() || !shouldScanFile(path)) {
    return;
  }
  scanFile(path);
}

function shouldScanFile(path) {
  if (path.includes(`${join("src-tauri", "gen")}${separatorFor(path)}`)) {
    return false;
  }
  const extension = extname(path);
  return textExtensions.has(extension);
}

function separatorFor(path) {
  return path.includes("\\") ? "\\" : "/";
}

function scanFile(path) {
  const text = readFileSync(path, "utf8");
  const activeChecks = typeScriptExtensions.has(extname(path)) ? [...checks, ...typeScriptChecks] : checks;
  for (const check of activeChecks) {
    for (const match of text.matchAll(check.pattern)) {
      const position = positionForOffset(text, match.index ?? 0);
      findings.push({
        file: relative(process.cwd(), path),
        line: position.line,
        column: position.column,
        name: check.name,
        text: lineAt(text, position.line).trim()
      });
    }
  }
}

function positionForOffset(text, offset) {
  const prefix = text.slice(0, offset);
  const lines = prefix.split("\n");
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1
  };
}

function lineAt(text, lineNumber) {
  return text.split(/\r?\n/)[lineNumber - 1] ?? "";
}
