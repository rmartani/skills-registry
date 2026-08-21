import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { test } from "node:test";
import { writeIndex } from "../../src/index/build-index.js";
import { prepareStagedPackages } from "../../src/package/live-packaging.js";
import { readZipArchive } from "../../src/package/archive-reader.js";
import { collectManifestFiles, validateRepository } from "../../src/schema/validate.js";

const rootDir = path.resolve(process.cwd());
const versionPath = "registry/projects/context7/resources/context7-mcp/versions/22222222-2222-4222-8222-222222222227.json";

class FakeArchiveClient {
  calls: Array<{ owner: string; repo: string; ref: string }> = [];
  constructor(private readonly archive: Uint8Array = zipSync({
    "context7-4.0.2/packages/mcp/SKILL.md": new TextEncoder().encode("safe payload\n"),
    "context7-4.0.2/LICENSE": new TextEncoder().encode("MIT\n")
  })) {}

  async downloadArchive(owner: string, repo: string, ref: string): Promise<Uint8Array> {
    this.calls.push({ owner, repo, ref });
    return this.archive;
  }
}

async function stagedRepository(monitoredPath = "packages/mcp"): Promise<{ temporary: string; versionPath: string }> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "skills-registry-package-prepare-"));
  await cp(rootDir, temporary, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(rootDir, source).split(path.sep).join("/");
      const isContext7Project = relative === "registry/projects/context7" || relative.startsWith("registry/projects/context7/");
      if (relative.startsWith("registry/projects/") && !isContext7Project) return false;
      return !relative.includes("node_modules/") && !relative.includes(".git/") && !relative.endsWith("dist");
    }
  });
  const absoluteVersionPath = path.join(temporary, versionPath);
  const version = JSON.parse((await readFile(absoluteVersionPath)).toString()) as Record<string, any>;
  version.packaging = { mode: "staged", packagedAt: "2026-08-19T00:00:00Z", artifactFileName: null, artifactSha256: null, payloadSha256: null, sizeBytes: null, githubReleaseTag: null };
  await writeFile(absoluteVersionPath, `${JSON.stringify(version, null, 2)}\n`);
  const resourcePath = path.join(temporary, "registry/projects/context7/resources/context7-mcp/resource.json");
  const resource = JSON.parse((await readFile(resourcePath)).toString()) as Record<string, any>;
  resource.source.monitoredPath = monitoredPath;
  await writeFile(resourcePath, `${JSON.stringify(resource, null, 2)}\n`);
  const targetRelativePath = path.relative(path.join(temporary, "registry"), absoluteVersionPath).replaceAll(path.sep, "/");
  for (const file of await collectManifestFiles(temporary)) {
    if (file.kind !== "resource-version" || file.path === targetRelativePath || file.document.packaging?.mode !== "staged") continue;
    await writeFile(
      path.join(temporary, "registry", file.path),
      `${JSON.stringify({ ...file.document, packaging: { ...file.document.packaging, mode: "link-only" } }, null, 2)}\n`
    );
  }
  await writeIndex(temporary);
  return { temporary, versionPath: absoluteVersionPath };
}

test("post-merge staging computes metadata, updates only the version and index, and validates strictly", async () => {
  const { temporary, versionPath: absoluteVersionPath } = await stagedRepository();
  try {
    const resourcePath = path.join(temporary, "registry/projects/context7/resources/context7-mcp/resource.json");
    const resourceBefore = await readFile(resourcePath);
    const client = new FakeArchiveClient();
    const outputDir = path.join(temporary, ".generated", "packages");
    const prepared = await prepareStagedPackages(temporary, outputDir, client);

    assert.equal(prepared.length, 1);
    assert.deepEqual(client.calls, [{ owner: "upstash", repo: "context7", ref: "@upstash/context7-mcp@4.0.2" }]);
    assert.equal(prepared[0]?.artifactFileName, "context7-mcp-4.0.2.zip");
    assert.equal(prepared[0]?.githubReleaseTag, "resource/context7-mcp/4.0.2");
    assert.equal(prepared[0]?.sizeBytes, (await stat(path.join(outputDir, "context7-mcp-4.0.2.zip"))).size);

    const converted = JSON.parse((await readFile(absoluteVersionPath)).toString()) as Record<string, any>;
    assert.equal(converted.packaging.mode, "registry-zip");
    assert.equal(converted.packaging.artifactSha256, prepared[0]?.artifactSha256);
    assert.equal(converted.packaging.payloadSha256, prepared[0]?.payloadSha256);
    assert.equal(converted.packaging.sizeBytes, prepared[0]?.sizeBytes);
    assert.deepEqual(await readFile(resourcePath), resourceBefore);
    await validateRepository(temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("exact monitored files are packaged under their basename", async () => {
  const { temporary } = await stagedRepository("packages/mcp/SKILL.md");
  try {
    const outputDir = path.join(temporary, ".generated", "packages");
    const prepared = await prepareStagedPackages(temporary, outputDir, new FakeArchiveClient());
    assert.equal(prepared.length, 1);

    const artifact = await readFile(path.join(outputDir, "context7-mcp-4.0.2.zip"));
    const entries = readZipArchive(artifact);
    const payload = entries.find((entry) => entry.path === "SKILL.md");
    assert.equal(new TextDecoder().decode(payload?.data), "safe payload\n");
    assert.equal(entries.some((entry) => entry.path === "packages/mcp/SKILL.md"), false);
    assert.ok(entries.some((entry) => entry.path === "LICENSE"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("unsafe staged archives fail before metadata conversion", async () => {
  const { temporary, versionPath: absoluteVersionPath } = await stagedRepository();
  try {
    const unsafe = zipSync({
      "context7-4.0.2/packages/mcp/SKILL.md": new TextEncoder().encode("safe payload\n"),
      "context7-4.0.2/LICENSE": new TextEncoder().encode("MIT\n"),
      "../escape": new TextEncoder().encode("blocked")
    });
    await assert.rejects(() => prepareStagedPackages(temporary, path.join(temporary, ".generated", "packages"), new FakeArchiveClient(unsafe)), /traversal|inseguro/i);
    const unchanged = JSON.parse((await readFile(absoluteVersionPath)).toString()) as Record<string, any>;
    assert.equal(unchanged.packaging.mode, "staged");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
