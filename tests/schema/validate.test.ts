import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeIndex } from "../../src/index/build-index.js";
import { createSchemaValidators, RegistryValidationError, validateRepository } from "../../src/schema/validate.js";

const rootDir = path.resolve(process.cwd());

const exampleBySchema: Record<string, string> = {
  project: "examples/project.json",
  collection: "examples/collection.json",
  resource: "examples/resource.json",
  "resource-version": "examples/resource-version.json",
  "collection-version": "examples/collection-version.json",
  "index.schema.json": "examples/index.json",
  "redirects.schema.json": "examples/redirects.json",
  "package-provenance.schema.json": "examples/package-provenance.json",
  "catalog-proposal.schema.json": "examples/catalog-proposal.json"
};

test("canonical registry validates with strict cross-references", async () => {
  const summary = await validateRepository(rootDir, { allowStaged: true });
  assert.ok(summary.projects >= 3, `expected the canonical projects plus any publication drafts, got ${summary.projects}`);
  assert.ok(summary.resources >= 7, `expected the canonical resources plus any publication drafts, got ${summary.resources}`);
  assert.ok(summary.versions >= 7, `expected the canonical versions plus any publication drafts, got ${summary.versions}`);
});

test("each example validates against its draft 2020-12 schema", async () => {
  const validators = await createSchemaValidators(rootDir);
  for (const [schemaKey, examplePath] of Object.entries(exampleBySchema)) {
    const document = JSON.parse((await readFile(path.join(rootDir, examplePath))).toString("utf8")) as unknown;
    const validator = validators.get(schemaKey);
    assert.ok(validator, `validator missing for ${schemaKey}`);
    assert.equal(validator!(document), true, `${schemaKey}: ${JSON.stringify(validator!.errors)}`);
  }
});

test("additional properties are rejected", async () => {
  const validators = await createSchemaValidators(rootDir);
  const resource = JSON.parse((await readFile(path.join(rootDir, "examples/resource.json"))).toString("utf8")) as Record<string, unknown>;
  resource.unexpected = true;
  const validator = validators.get("resource")!;
  assert.equal(validator(resource), false);
});

test("registry ZIP metadata remains strict while staged carries nulls", async () => {
  const validators = await createSchemaValidators(rootDir);
  const version = JSON.parse((await readFile(path.join(rootDir, "examples/resource-version.json"))).toString()) as Record<string, any>;
  version.packaging = { mode: "registry-zip", packagedAt: "2026-08-19T00:00:00Z", artifactFileName: "fixture-1.0.0.zip", artifactSha256: "0".repeat(64), payloadSha256: "1".repeat(64), sizeBytes: 1, githubReleaseTag: "resource/fixture/1.0.0" };
  version.packaging.artifactSha256 = null;
  assert.equal(validators.get("resource-version")!(version), false);
  version.packaging = { mode: "staged", packagedAt: "2026-08-19T00:00:00Z", artifactFileName: null, artifactSha256: null, payloadSha256: null, sizeBytes: null, githubReleaseTag: null };
  assert.equal(validators.get("resource-version")!(version), true);
});

test("staged versions are accepted only for the explicit publication handoff", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "skills-registry-staged-"));
  try {
    await cp(rootDir, temporary, { recursive: true, filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`) && !source.includes(`${path.sep}.git${path.sep}`) && !source.endsWith(`${path.sep}dist`) });
    const versionPath = path.join(temporary, "registry/projects/context7/resources/context7-mcp/versions/22222222-2222-4222-8222-222222222227.json");
    const version = JSON.parse((await readFile(versionPath)).toString()) as Record<string, any>;
    version.packaging = { mode: "staged", packagedAt: "2026-08-19T00:00:00Z", artifactFileName: null, artifactSha256: null, payloadSha256: null, sizeBytes: null, githubReleaseTag: null };
    await writeFile(versionPath, `${JSON.stringify(version, null, 2)}\n`);
    await writeIndex(temporary);
    await assert.rejects(() => validateRepository(temporary), /transitório/);
    const summary = await validateRepository(temporary, { allowStaged: true });
    assert.ok(summary.versions >= 7, `expected the canonical versions plus any publication drafts, got ${summary.versions}`);
    const resourcePath = path.join(temporary, "registry/projects/context7/resources/context7-mcp/resource.json");
    const resource = JSON.parse((await readFile(resourcePath)).toString()) as Record<string, any>;
    resource.official.license.redistribution = "link-only";
    await writeFile(resourcePath, `${JSON.stringify(resource, null, 2)}\n`);
    await writeIndex(temporary);
    await assert.rejects(() => validateRepository(temporary, { allowStaged: true }), /staged exige licença/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("duplicate resource version refs fail repository validation", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "skills-registry-duplicate-version-ref-"));
  try {
    await cp(rootDir, temporary, { recursive: true, filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`) && !source.includes(`${path.sep}.git${path.sep}`) && !source.endsWith(`${path.sep}dist`) });
    const sourcePath = path.join(temporary, "registry/projects/context7/resources/context7-mcp/versions/22222222-2222-4222-8222-222222222227.json");
    const duplicatePath = path.join(temporary, "registry/projects/context7/resources/context7-mcp/versions/22222222-2222-4222-8222-222222222230.json");
    const duplicate = JSON.parse((await readFile(sourcePath)).toString("utf8")) as Record<string, unknown>;
    duplicate.id = "22222222-2222-4222-8222-222222222230";
    await writeFile(duplicatePath, `${JSON.stringify(duplicate, null, 2)}\n`);
    await writeIndex(temporary);
    await assert.rejects(() => validateRepository(temporary), /duplicado no Resource/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("link-only licenses cannot publish registry ZIPs", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "skills-registry-license-"));
  try {
    await cp(rootDir, temporary, { recursive: true, filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`) && !source.endsWith(`${path.sep}dist`) });
    const resourcePath = path.join(temporary, "registry/projects/context7/resources/context7-mcp/resource.json");
    const resource = JSON.parse((await readFile(resourcePath)).toString("utf8")) as Record<string, any>;
    resource.official.license.redistribution = "link-only";
    await writeFile(resourcePath, `${JSON.stringify(resource, null, 2)}\n`);
    await writeIndex(temporary);
    await assert.rejects(() => validateRepository(temporary), /licença link-only/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("orphan references and redirect cycles fail repository validation", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "skills-registry-schema-"));
  try {
    await cp(rootDir, temporary, { recursive: true, filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`) && !source.endsWith(`${path.sep}dist`) });
    const resourcePath = path.join(temporary, "registry/projects/context7/resources/context7-mcp/resource.json");
    const resource = JSON.parse((await readFile(resourcePath)).toString("utf8")) as Record<string, unknown>;
    resource.recommendedVersionId = "99999999-9999-4999-8999-999999999999";
    await writeFile(resourcePath, `${JSON.stringify(resource, null, 2)}\n`);
    await assert.rejects(() => validateRepository(temporary), RegistryValidationError);
    resource.recommendedVersionId = "22222222-2222-4222-8222-222222222227";
    await writeFile(resourcePath, `${JSON.stringify(resource, null, 2)}\n`);
    await writeFile(path.join(temporary, "registry/redirects.json"), `${JSON.stringify({ schemaVersion: "1.0.0", kind: "redirects", redirects: [
      { from: "old-one", to: "old-two", resourceId: "22222222-2222-4222-8222-222222222224", reason: "test" },
      { from: "old-two", to: "old-one", resourceId: "22222222-2222-4222-8222-222222222224", reason: "test" }
    ] }, null, 2)}\n`);
    await assert.rejects(() => validateRepository(temporary), RegistryValidationError);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
