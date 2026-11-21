import { execFileSync } from "node:child_process";

// The planner never sees the whole repository: a capped file list, the package manifest and the
// README start, plus read-only tools for the parts that matter. Everything is read from baseSha,
// so the plan sees exactly the tree the workers will start from.
const MAP_MAX_FILES = 2000;
const README_CHARS = 2000;
const LIST_MAX_ENTRIES = 500;
const INSTRUCTION_CHARS = 3000;

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
}

function safePath(value: unknown, name: string): string {
  const text = String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!text || text.startsWith("-") || text.includes("\0") || text.includes(":") || text.startsWith("/") || text.split("/").includes("..")) {
    throw new Error(`${name} must be a repository-relative path without ":"`);
  }
  return text;
}

export function repoMap(repoRoot: string, baseSha: string): string {
  const files = git(repoRoot, ["ls-tree", "-r", "--name-only", "-z", baseSha]).split("\0").filter(Boolean);
  const shown = files.slice(0, MAP_MAX_FILES);
  const sections = [`${files.length} tracked files${files.length > shown.length ? `; showing the first ${shown.length}` : ""}:`, ...shown];
  const show = (file: string): string | undefined => {
    try { return git(repoRoot, ["show", `${baseSha}:${file}`]); } catch { return undefined; }
  };
  const manifest = show("package.json");
  if (manifest) {
    try {
      const parsed = JSON.parse(manifest) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const scripts = Object.entries(parsed.scripts ?? {}).map(([name, command]) => `${name}: ${command}`);
      const dependencies = Object.entries({ ...parsed.dependencies, ...parsed.devDependencies }).map(([name, version]) => `${name}@${version}`);
      sections.push("", "package.json scripts:", ...(scripts.length ? scripts : ["(none)"]), "", "dependencies:", ...(dependencies.length ? dependencies : ["(none)"]));
    } catch {
      // An unreadable manifest is not worth failing the run over; the file list still helps.
    }
  }
  const readme = show("README.md")?.slice(0, README_CHARS);
  if (readme) sections.push("", `README.md (first ${README_CHARS} characters):`, readme);
  for (const file of ["pyproject.toml", "Cargo.toml", "go.mod"]) {
    const text = show(file)?.slice(0, 1000);
    if (text) sections.push("", `${file} (first 1000 characters):`, text);
  }
  return sections.join("\n");
}

/** Project conventions for workers: the start of AGENTS.md, CLAUDE.md and README.md at the base commit. */
export function projectInstructions(repoRoot: string, baseSha: string): string {
  const show = (file: string): string | undefined => {
    try { return git(repoRoot, ["show", `${baseSha}:${file}`]); } catch { return undefined; }
  };
  return ["AGENTS.md", "CLAUDE.md", "README.md"].flatMap((file) => {
    const text = show(file)?.slice(0, INSTRUCTION_CHARS);
    return text ? [`${file} (first ${INSTRUCTION_CHARS} characters):\n${text}`] : [];
  }).join("\n\n");
}

export const plannerToolDefinitions: Array<Record<string, unknown>> = [
  { name: "list_dir", description: "List the entries of a repository directory; paths are repository-relative and \".\" is the root", input_schema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "read_file", description: "Read a UTF-8 file from the repository. Pass startLine and maxLines to read a range of a large file.", input_schema: { type: "object", properties: { path: { type: "string" }, startLine: { type: "number" }, maxLines: { type: "number" } }, required: ["path"] } },
  { name: "search", description: "Search the repository text for a fixed string; returns matching lines with file and line number", input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
];

/** Read-only repository access for the planner. Every call is confined to the run's base commit. */
export async function runReadTool(repoRoot: string, baseSha: string, name: string, args: Record<string, unknown>, limits: { maxReadLines: number; maxSearchHits: number }): Promise<unknown> {
  if (name === "list_dir") {
    const target = args.path === undefined || args.path === "" ? "." : safePath(args.path, "path");
    let output: string;
    try { output = git(repoRoot, target === "." ? ["ls-tree", "-z", baseSha] : ["ls-tree", "-z", `${baseSha}:${target}`]); }
    catch { throw new Error(`cannot list ${target}: it is not a directory at the run's base commit`); }
    const entries = output.split("\0").filter(Boolean).map((line) => {
      const [meta, entry] = line.split("\t");
      return meta?.endsWith(" tree") ? `${entry}/` : entry ?? "";
    });
    return entries.slice(0, LIST_MAX_ENTRIES);
  }
  if (name === "read_file") {
    const file = safePath(args.path, "path");
    let content: string;
    try { content = git(repoRoot, ["show", `${baseSha}:${file}`]); }
    catch { throw new Error(`cannot read ${file} at the run's base commit`); }
    if (content.includes("\0")) throw new Error(`${file} is a binary file`);
    const lines = content.split("\n");
    const start = Math.max(1, Math.floor(Number(args.startLine) || 1));
    const limit = Math.max(1, Math.min(Math.floor(Number(args.maxLines) || limits.maxReadLines), limits.maxReadLines));
    const end = Math.min(lines.length, start - 1 + limit);
    if (start === 1 && end === lines.length) return content;
    return `${lines.slice(start - 1, end).join("\n")}\n… (lines ${start}-${end} of ${lines.length})`;
  }
  if (name === "search") {
    const pattern = String(args.pattern ?? "");
    if (!pattern || pattern.length > 200) throw new Error("pattern must be 1-200 characters");
    let output = "";
    try { output = git(repoRoot, ["grep", "-n", "-I", "-F", "-e", pattern, baseSha, "--"]); }
    catch (error) {
      // git grep exits 1 when nothing matches; anything else is a real failure.
      if ((error as { status?: number }).status !== 1) throw error;
    }
    const hits = output.split("\n").filter(Boolean).map((line) => line.replace(`${baseSha}:`, ""));
    const rest = hits.length > limits.maxSearchHits ? [`… ${hits.length - limits.maxSearchHits} more matches`] : [];
    return [...hits.slice(0, limits.maxSearchHits), ...rest].join("\n") || "(no matches)";
  }
  throw new Error(`unknown repository tool: ${name}`);
}
