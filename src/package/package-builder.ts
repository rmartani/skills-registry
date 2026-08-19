import { zipSync } from "fflate";
import { createProvenance, type ProvenanceDocument } from "./provenance.js";
import { payloadSha256, sha256, type PayloadEntry } from "./checksum.js";
import { validateArchiveEntries, type ArchiveEntry, type ArchiveLimits, DEFAULT_ARCHIVE_LIMITS } from "./archive-validator.js";
import type { ResourceManifest, ResourceVersionManifest } from "./types.js";

export interface PackageBuildResult {
  artifact: Uint8Array;
  artifactSha256: string;
  payloadSha256: string;
  payloadFileCount: number;
  payloadBytes: number;
  provenance: ProvenanceDocument;
  fileName: string;
}

function safeVersionPart(label: string, maxLength = 160): string {
  const normalized = label
    .trim()
    .replaceAll("/", "-")
    .replaceAll("@", "at")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return (normalized || "version").slice(0, maxLength).replace(/-+$/g, "") || "version";
}

function resourceVersionPart(resource: ResourceManifest, version: ResourceVersionManifest): string {
  return safeVersionPart(version.label, Math.max(1, 160 - resource.slug.length - 1));
}

export function artifactFileName(resource: ResourceManifest, version: ResourceVersionManifest): string {
  return `${resource.slug}-${resourceVersionPart(resource, version)}.zip`;
}

export function githubReleaseTag(resource: ResourceManifest, version: ResourceVersionManifest): string {
  return `resource/${resource.slug}/${resourceVersionPart(resource, version)}`;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function buildDeterministicPackage(
  resource: ResourceManifest,
  version: ResourceVersionManifest,
  payloadEntries: ArchiveEntry[],
  options: { packagedAt: string; licenseEntries?: ArchiveEntry[]; limits?: Partial<ArchiveLimits> }
): PackageBuildResult {
  const licenseEntries = options.licenseEntries ?? [];
  const payloadByPath = new Map<string, ArchiveEntry>();
  for (const entry of [...payloadEntries, ...licenseEntries]) {
    const normalizedPath = entry.path.replaceAll("\\", "/");
    if (!payloadByPath.has(normalizedPath)) payloadByPath.set(normalizedPath, { ...entry, path: normalizedPath });
  }
  const payload = [...payloadByPath.values()];
  validateArchiveEntries(payload, { limits: { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits }, requiredNoticePaths: resource.official.license.redistribution === "allowed" ? resource.official.license.noticePaths : [] });
  const payloadForHash: PayloadEntry[] = payload.filter((entry) => entry.type !== "directory").map((entry) => ({ path: entry.path, data: entry.data }));
  const provenance = createProvenance(resource, version, payloadForHash, options.packagedAt);
  const provenanceBytes = utf8(`${JSON.stringify(provenance, null, 2)}\n`);
  const allEntries = [...payloadForHash, { path: "STANCATTI-REGISTRY.json", data: provenanceBytes }].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const zipInput: Record<string, Uint8Array> = {};
  for (const entry of allEntries) zipInput[entry.path] = entry.data;
  const packagedDate = new Date(options.packagedAt);
  if (Number.isNaN(packagedDate.getTime())) throw new Error(`packagedAt inválido: ${options.packagedAt}`);
  // fflate serializes DOS timestamps through local Date getters. Shift the Date
  // so the resulting calendar fields are UTC-identical on every runner timezone.
  const zipMtime = new Date(packagedDate.getTime() + packagedDate.getTimezoneOffset() * 60_000);
  const artifact = zipSync(zipInput, { level: 6, mtime: zipMtime });
  if (artifact.byteLength > (options.limits?.maxArchiveBytes ?? DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes)) {
    throw new Error(`ZIP excede ${options.limits?.maxArchiveBytes ?? DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes} bytes.`);
  }
  return {
    artifact,
    artifactSha256: sha256(artifact),
    payloadSha256: payloadSha256(payloadForHash),
    payloadFileCount: payloadForHash.length,
    payloadBytes: payloadForHash.reduce((total, entry) => total + entry.data.byteLength, 0),
    provenance,
    fileName: artifactFileName(resource, version)
  };
}
