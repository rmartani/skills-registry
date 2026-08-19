export interface ArchiveEntry {
  path: string;
  data: Uint8Array;
  mode?: number;
  type?: "file" | "directory" | "symlink";
}

export interface ArchiveLimits {
  maxArchiveBytes: number;
  maxExpandedBytes: number;
  maxFileBytes: number;
  maxFiles: number;
  maxPathLength: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxArchiveBytes: 50 * 1024 * 1024,
  maxExpandedBytes: 200 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
  maxFiles: 10_000,
  maxPathLength: 240
};

export function validateArchiveEntries(entries: ArchiveEntry[], options: { limits?: Partial<ArchiveLimits>; requiredNoticePaths?: string[]; allowSymlinks?: boolean } = {}): void {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits };
  if (entries.length > limits.maxFiles) throw new Error(`Arquivo excede o limite de ${limits.maxFiles} arquivos.`);
  const paths = new Set<string>();
  let expandedBytes = 0;
  for (const entry of entries) {
    const normalized = entry.path.replaceAll("\\", "/");
    if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) throw new Error(`Caminho de arquivo inseguro: ${entry.path}`);
    const pathForCheck = entry.type === "directory" && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
    const segments = pathForCheck.split("/");
    if (segments.some((segment) => segment === ".." || segment === "")) throw new Error(`Path traversal detectado: ${entry.path}`);
    if (pathForCheck.length > limits.maxPathLength) throw new Error(`Caminho excede ${limits.maxPathLength} caracteres: ${entry.path}`);
    if (paths.has(normalized)) throw new Error(`Caminho duplicado: ${normalized}`);
    paths.add(normalized);
    const mode = entry.mode ?? 0o100644;
    const fileType = mode & 0o170000;
    const isSymlink = entry.type === "symlink" || fileType === 0o120000;
    if (isSymlink && !options.allowSymlinks) throw new Error(`Symlink não permitido: ${entry.path}`);
    if (!isSymlink && entry.type !== "directory" && fileType !== 0 && fileType !== 0o100000) throw new Error(`Tipo especial não permitido: ${entry.path}`);
    if (entry.type === "directory") continue;
    if (entry.data.byteLength > limits.maxFileBytes) throw new Error(`Arquivo excede ${limits.maxFileBytes} bytes: ${entry.path}`);
    expandedBytes += entry.data.byteLength;
    if (expandedBytes > limits.maxExpandedBytes) throw new Error(`Arquivo expandido excede ${limits.maxExpandedBytes} bytes.`);
  }
  for (const noticePath of options.requiredNoticePaths ?? []) {
    if (!paths.has(noticePath)) throw new Error(`Aviso obrigatório ausente: ${noticePath}`);
  }
}

export function stripArchiveRoot(entries: ArchiveEntry[]): ArchiveEntry[] {
  const firstSegments = entries.map((entry) => entry.path.split("/")[0]).filter((segment): segment is string => Boolean(segment));
  const root = firstSegments.length > 0 && new Set(firstSegments).size === 1 ? `${firstSegments[0]}/` : "";
  return entries
    .map((entry) => ({ ...entry, path: root && entry.path.startsWith(root) ? entry.path.slice(root.length) : entry.path }))
    .filter((entry) => entry.path !== "");
}
