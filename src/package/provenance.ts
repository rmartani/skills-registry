import type { ResourceManifest, ResourceVersionManifest } from "./types.js";
import { payloadSha256, type PayloadEntry } from "./checksum.js";

export interface ProvenanceDocument {
  schemaVersion: "1.0.0";
  kind: "stancatti-registry-package";
  resourceId: string;
  resourceSlug: string;
  origin: {
    repositoryUrl: string;
    refType: "release" | "tag" | "commit";
    refValue: string;
    commitSha: string;
    monitoredPath: string;
  };
  packagedAt: string;
  license: { spdx: string; includedFiles: string[] };
  payload: { sha256: string; fileCount: number; uncompressedBytes: number };
}

export function createProvenance(resource: ResourceManifest, version: ResourceVersionManifest, entries: PayloadEntry[], packagedAt: string): ProvenanceDocument {
  return {
    schemaVersion: "1.0.0",
    kind: "stancatti-registry-package",
    resourceId: resource.id,
    resourceSlug: resource.slug,
    origin: {
      repositoryUrl: resource.source.repositoryUrl,
      refType: version.ref.type,
      refValue: version.ref.value,
      commitSha: version.ref.commitSha,
      monitoredPath: resource.source.monitoredPath
    },
    packagedAt,
    license: { spdx: resource.official.license.spdx, includedFiles: resource.official.license.noticePaths },
    payload: {
      sha256: payloadSha256(entries),
      fileCount: entries.length,
      uncompressedBytes: entries.reduce((total, entry) => total + entry.data.byteLength, 0)
    }
  };
}
