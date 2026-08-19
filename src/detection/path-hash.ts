import { createHash } from "node:crypto";

export interface GitTreeEntry {
  path: string;
  sha: string;
  mode: string;
  type?: "blob" | "tree" | "commit";
}

export type TreeEntryFilter = (relativePath: string, entry: GitTreeEntry) => boolean;

export function normalizeMonitoredPath(monitoredPath: string): string {
  const normalized = monitoredPath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (normalized === "") return ".";
  if (normalized === ".") return ".";
  if (normalized.startsWith("/") || normalized.split("/").some((segment) => segment === ".." || segment === "")) {
    throw new Error(`monitoredPath inseguro: ${monitoredPath}`);
  }
  return normalized;
}

export function relativeTreePath(filePath: string, monitoredPath: string): string | undefined {
  const monitor = normalizeMonitoredPath(monitoredPath);
  const normalized = filePath.replaceAll("\\", "/");
  if (monitor === ".") return normalized;
  if (normalized === monitor) return "";
  const prefix = `${monitor}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : undefined;
}

export function entriesWithinPath(entries: GitTreeEntry[], monitoredPath: string, filter: TreeEntryFilter = () => true): GitTreeEntry[] {
  return entries
    .filter((entry) => entry.type === undefined || entry.type === "blob")
    .map((entry) => {
      const relative = relativeTreePath(entry.path, monitoredPath);
      return relative === undefined || relative === "" || !filter(relative, entry) ? undefined : { ...entry, path: relative };
    })
    .filter((entry): entry is GitTreeEntry => entry !== undefined)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Hashes only the monitored tree. The exact byte stream is the ordered sequence
 * `relativePath + NUL + blobSha + NUL + gitMode`, with no locale-dependent sort.
 */
export function hashTreeEntries(entries: GitTreeEntry[], monitoredPath: string, filter: TreeEntryFilter = () => true): string {
  const hash = createHash("sha256");
  for (const entry of entriesWithinPath(entries, monitoredPath, filter)) {
    hash.update(entry.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(entry.sha, "utf8");
    hash.update("\0", "utf8");
    hash.update(entry.mode, "utf8");
  }
  return hash.digest("hex");
}

export function changedTreePaths(previous: GitTreeEntry[], next: GitTreeEntry[], monitoredPath: string, filter: TreeEntryFilter = () => true): string[] {
  const before = new Map(entriesWithinPath(previous, monitoredPath, filter).map((entry) => [entry.path, `${entry.sha}:${entry.mode}`]));
  const after = new Map(entriesWithinPath(next, monitoredPath, filter).map((entry) => [entry.path, `${entry.sha}:${entry.mode}`]));
  const changed = new Set<string>();
  for (const [filePath, signature] of before) if (after.get(filePath) !== signature) changed.add(filePath);
  for (const [filePath, signature] of after) if (before.get(filePath) !== signature) changed.add(filePath);
  return [...changed].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
