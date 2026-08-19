import { unzipSync } from "fflate";
import { DEFAULT_ARCHIVE_LIMITS, type ArchiveEntry } from "./archive-validator.js";

function readUInt32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 3] ?? 0) << 24);
}

function readUInt16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function centralDirectoryModes(bytes: Uint8Array): Map<string, number> {
  const modes = new Map<string, number>();
  for (let offset = 0; offset + 46 <= bytes.length; offset += 1) {
    if (readUInt32(bytes, offset) !== 0x02014b50) continue;
    const nameLength = readUInt16(bytes, offset + 28);
    const extraLength = readUInt16(bytes, offset + 30);
    const commentLength = readUInt16(bytes, offset + 32);
    const externalAttributes = readUInt32(bytes, offset + 38) >>> 0;
    const name = new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    modes.set(name, unixMode || (name.endsWith("/") ? 0o040755 : 0o100644));
    offset += 46 + nameLength + extraLength + commentLength - 1;
  }
  return modes;
}

export function readZipArchive(bytes: Uint8Array, maxArchiveBytes = DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes): ArchiveEntry[] {
  if (bytes.byteLength > maxArchiveBytes) throw new Error(`ZIP excede ${maxArchiveBytes} bytes.`);
  const unzipped = unzipSync(bytes);
  const modes = centralDirectoryModes(bytes);
  return Object.entries(unzipped).map(([entryPath, data]) => {
    const mode = modes.get(entryPath) ?? (entryPath.endsWith("/") ? 0o040755 : 0o100644);
    const fileType = mode & 0o170000;
    return { path: entryPath, data, mode, type: entryPath.endsWith("/") ? "directory" : fileType === 0o120000 ? "symlink" : "file" };
  });
}
