import { createHash } from "node:crypto";

export interface PayloadEntry {
  path: string;
  data: Uint8Array;
}

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function payloadSha256(entries: PayloadEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(entry.path, "utf8");
    hash.update("\0", "utf8");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(entry.data.byteLength));
    hash.update(length);
    hash.update(entry.data);
  }
  return hash.digest("hex");
}
