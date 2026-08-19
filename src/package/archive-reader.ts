import { unzipSync } from "fflate";
import { DEFAULT_ARCHIVE_LIMITS, validateArchiveEntries, type ArchiveEntry, type ArchiveLimits } from "./archive-validator.js";

function readUInt32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 3] ?? 0) << 24)) >>> 0;
}

function readUInt16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

interface CentralEntry {
  path: string;
  mode: number;
  type: "file" | "directory" | "symlink";
  uncompressedSize: number;
}

function centralDirectoryEntries(bytes: Uint8Array): CentralEntry[] {
  const entries: CentralEntry[] = [];
  for (let offset = 0; offset + 46 <= bytes.length; offset += 1) {
    if (readUInt32(bytes, offset) !== 0x02014b50) continue;
    const nameLength = readUInt16(bytes, offset + 28);
    const extraLength = readUInt16(bytes, offset + 30);
    const commentLength = readUInt16(bytes, offset + 32);
    const uncompressedSize = readUInt32(bytes, offset + 24);
    if (uncompressedSize === 0xffffffff) throw new Error("ZIP64 não suportado para validação segura.");
    const externalAttributes = readUInt32(bytes, offset + 38);
    const name = new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const mode = unixMode || (name.endsWith("/") ? 0o040755 : 0o100644);
    const fileType = mode & 0o170000;
    entries.push({
      path: name,
      mode,
      type: name.endsWith("/") ? "directory" : fileType === 0o120000 ? "symlink" : "file",
      uncompressedSize
    });
    offset += 46 + nameLength + extraLength + commentLength - 1;
  }
  return entries;
}

function validateCentralDirectory(entries: CentralEntry[], limits: ArchiveLimits, allowSymlinks: boolean): void {
  if (entries.length > limits.maxFiles) throw new Error(`Arquivo excede o limite de ${limits.maxFiles} arquivos.`);
  let expandedBytes = 0;
  const metadata: ArchiveEntry[] = entries.map((entry) => {
    if (entry.uncompressedSize > limits.maxFileBytes) throw new Error(`Arquivo excede ${limits.maxFileBytes} bytes: ${entry.path}`);
    expandedBytes += entry.uncompressedSize;
    if (expandedBytes > limits.maxExpandedBytes) throw new Error(`Arquivo expandido excede ${limits.maxExpandedBytes} bytes.`);
    return { path: entry.path, mode: entry.mode, type: entry.type, data: new Uint8Array() };
  });
  // This validates path traversal, absolute paths, symlinks and special modes
  // before fflate allocates/decompresses any payload.
  validateArchiveEntries(metadata, { limits, allowSymlinks });
}

export interface ZipReadOptions {
  limits?: Partial<ArchiveLimits>;
  allowSymlinks?: boolean;
}

export function readZipArchive(bytes: Uint8Array, options: ZipReadOptions | number = {}): ArchiveEntry[] {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...(typeof options === "number" ? { maxArchiveBytes: options } : options.limits) };
  const allowSymlinks = typeof options === "number" ? false : options.allowSymlinks ?? false;
  if (bytes.byteLength > limits.maxArchiveBytes) throw new Error(`ZIP excede ${limits.maxArchiveBytes} bytes.`);
  const centralEntries = centralDirectoryEntries(bytes);
  validateCentralDirectory(centralEntries, limits, allowSymlinks);
  const unzipped = unzipSync(bytes);
  const modes = new Map(centralEntries.map((entry) => [entry.path, entry]));
  const entries = Object.entries(unzipped).map(([entryPath, data]) => {
    const central = modes.get(entryPath);
    const mode = central?.mode ?? (entryPath.endsWith("/") ? 0o040755 : 0o100644);
    const fileType = mode & 0o170000;
    return { path: entryPath, data, mode, type: entryPath.endsWith("/") ? "directory" : fileType === 0o120000 ? "symlink" : "file" } as ArchiveEntry;
  });
  validateArchiveEntries(entries, { limits, allowSymlinks });
  return entries;
}
