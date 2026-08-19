import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDeterministicPackage } from "../../src/package/package-builder.js";
import { sha256 } from "../../src/package/checksum.js";
import { validateArchiveEntries, type ArchiveEntry } from "../../src/package/archive-validator.js";
import { readZipArchive } from "../../src/package/archive-reader.js";
import type { ResourceManifest, ResourceVersionManifest } from "../../src/package/types.js";

const resource: ResourceManifest = {
  schemaVersion: "1.0.0", kind: "resource", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", collectionId: null, slug: "fixture-resource", type: "skill",
  publication: { status: "active", publishedAt: "2026-08-19T00:00:00Z", archivedAt: null },
  official: { name: "Fixture", description: "Fixture", homepageUrl: "https://example.com", repositoryUrl: "https://github.com/example/fixture", maintainer: { name: "Fixture", url: "https://example.com/maintainer" }, license: { spdx: "MIT", name: "MIT License", url: "https://opensource.org/license/mit", redistribution: "allowed", noticePaths: ["LICENSE"] } },
  editorial: { descriptionPtBr: "Fixture", notesPtBr: null, tags: ["fixture"] },
  source: { repositoryUrl: "https://github.com/example/fixture", monitoredPath: ".", versionStrategy: "git-tag", packageName: null, tagPattern: "^v", candidatePolicy: "stable", includeExperimental: false },
  installationVariants: [{ key: "web", target: "generic", label: "Web", kind: "url", command: null, url: "https://example.com/install", steps: null, warningPtBr: null, officialSourceUrl: "https://example.com/install" }], recommendedVersionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
};
const version: ResourceVersionManifest = {
  schemaVersion: "1.0.0", kind: "resource-version", id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", resourceId: resource.id, label: "1.0.0", ref: { type: "tag", value: "v1.0.0", commitSha: "1111111111111111111111111111111111111111" }, monitoredPathSha256: "2222222222222222222222222222222222222222222222222222222222222222", upstreamPublishedAt: "2026-08-18T00:00:00Z", approvedAt: "2026-08-19T00:00:00Z", officialDownloadUrl: "https://github.com/example/fixture/releases/tag/v1.0.0", packaging: { mode: "registry-zip", packagedAt: "2026-08-19T00:00:00Z", artifactFileName: "fixture-resource-1.0.0.zip", artifactSha256: "0".repeat(64), payloadSha256: "0".repeat(64), sizeBytes: 1, githubReleaseTag: "resource/fixture-resource/1.0.0" }
};
const entries: ArchiveEntry[] = [{ path: "README.md", data: new TextEncoder().encode("no scripts are run\n") }, { path: "LICENSE", data: new TextEncoder().encode("MIT\n") }];

test("deterministic package includes provenance and stable checksums", () => {
  const first = buildDeterministicPackage(resource, version, entries, { packagedAt: "2026-08-19T00:00:00Z" });
  const second = buildDeterministicPackage(resource, version, entries, { packagedAt: "2026-08-19T00:00:00Z" });
  assert.equal(sha256(first.artifact), sha256(second.artifact));
  assert.equal(first.artifactSha256, second.artifactSha256);
  assert.equal(first.payloadSha256, second.payloadSha256);
  const archiveEntries = readZipArchive(first.artifact);
  assert.ok(archiveEntries.some((entry) => entry.path === "STANCATTI-REGISTRY.json"));
  assert.ok(archiveEntries.some((entry) => entry.path === "LICENSE"));
});

test("unsafe archive paths and filesystem types are rejected", () => {
  assert.throws(() => validateArchiveEntries([{ path: "../escape", data: new Uint8Array() }]));
  assert.throws(() => validateArchiveEntries([{ path: "/absolute", data: new Uint8Array() }]));
  assert.throws(() => validateArchiveEntries([{ path: "link", data: new Uint8Array(), type: "symlink", mode: 0o120777 }]));
  assert.throws(() => validateArchiveEntries([{ path: "device", data: new Uint8Array(), mode: 0o060644 }]));
  assert.throws(() => validateArchiveEntries([{ path: "README", data: new Uint8Array() }], { requiredNoticePaths: ["LICENSE"] }));
});

test("archive limits reject expansion and file-count abuse", () => {
  assert.throws(() => validateArchiveEntries([{ path: "large", data: new Uint8Array(5) }], { limits: { maxFileBytes: 4 } }));
  assert.throws(() => validateArchiveEntries([{ path: "one", data: new Uint8Array() }, { path: "two", data: new Uint8Array() }], { limits: { maxFiles: 1 } }));
});
