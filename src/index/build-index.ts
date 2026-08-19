import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectManifestFiles, type ManifestKind } from "../schema/validate.js";

export interface RegistryIndexEntry {
  path: string;
  kind: ManifestKind;
  id: string;
  sha256: string;
}

export interface RegistryIndex {
  schemaVersion: "1.0.0";
  kind: "registry-index";
  entries: RegistryIndexEntry[];
}

export async function buildIndex(rootDir: string): Promise<RegistryIndex> {
  const files = await collectManifestFiles(rootDir);
  return {
    schemaVersion: "1.0.0",
    kind: "registry-index",
    entries: files.map((file) => ({
      path: file.path,
      kind: file.kind,
      id: file.id,
      sha256: createHash("sha256").update(file.bytes).digest("hex")
    }))
  };
}

export function serializeIndex(index: RegistryIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

export async function writeIndex(rootDir: string): Promise<RegistryIndex> {
  const index = await buildIndex(rootDir);
  await writeFile(path.join(rootDir, "registry", "index.json"), serializeIndex(index), "utf8");
  return index;
}

export async function readIndex(rootDir: string): Promise<RegistryIndex> {
  return JSON.parse((await readFile(path.join(rootDir, "registry", "index.json"))).toString("utf8")) as RegistryIndex;
}
