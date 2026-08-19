import assert from "node:assert/strict";
import { test } from "node:test";
import { detectLatestVersion, type DetectionSource } from "../../src/detection/version-detector.js";
import type { GitHubClient } from "../../src/github/github-client.js";

const source: DetectionSource = {
  repositoryUrl: "https://github.com/example/project",
  monitoredPath: "skills",
  versionStrategy: "github-release",
  packageName: null,
  tagPattern: "^v",
  candidatePolicy: "stable",
  includeExperimental: false
};

function fakeClient(overrides: Partial<Record<"getRepository" | "listReleases" | "listTags" | "resolveRefCommit" | "getTree" | "compareCommits" | "getNpmPackageMetadata", (...args: never[]) => unknown>> = {}): GitHubClient {
  return {
    getRepository: overrides.getRepository ?? (async () => ({ full_name: "example/project", default_branch: "main", html_url: "https://github.com/example/project", license: { spdx_id: "MIT" } })),
    listReleases: overrides.listReleases ?? (async () => []),
    listTags: overrides.listTags ?? (async () => []),
    resolveRefCommit: overrides.resolveRefCommit ?? (async () => "1111111111111111111111111111111111111111"),
    getTree: overrides.getTree ?? (async () => ({ sha: "tree", truncated: false, tree: [{ path: "skills/SKILL.md", mode: "100644", type: "blob", sha: "blob" }] })),
    compareCommits: overrides.compareCommits ?? (async () => ({ files: [] })),
    getNpmPackageMetadata: overrides.getNpmPackageMetadata ?? (async () => ({ name: "fixture", versions: {}, time: {} }))
  } as unknown as GitHubClient;
}

test("release detection ignores drafts/prereleases and returns stable release", async () => {
  const client = fakeClient({
    listReleases: async () => [
      { tag_name: "v9.0.0-beta.1", name: "beta", draft: false, prerelease: true, created_at: "2026-08-19T00:00:00Z", published_at: "2026-08-19T00:00:00Z", html_url: "https://github.com/example/project/releases/tag/v9.0.0-beta.1", zipball_url: "https://example.com/beta.zip", target_commitish: "main" },
      { tag_name: "v1.2.0", name: "stable", draft: false, prerelease: false, created_at: "2026-08-18T00:00:00Z", published_at: "2026-08-18T00:00:00Z", html_url: "https://github.com/example/project/releases/tag/v1.2.0", zipball_url: "https://example.com/stable.zip", target_commitish: "main" }
    ]
  });
  const detected = await detectLatestVersion(client, source);
  assert.equal(detected?.refValue, "v1.2.0");
  assert.equal(detected?.refType, "release");
});

test("package-release detection resolves the npm version to its tagged upstream commit", async () => {
  const client = fakeClient({
    getNpmPackageMetadata: async () => ({ name: "@fixture/pkg", versions: { "1.0.0": {}, "2.0.0-beta.1": {} }, time: { "1.0.0": "2026-08-18T00:00:00Z" } }),
    resolveRefCommit: async () => "5555555555555555555555555555555555555555"
  });
  const packageSource = { ...source, versionStrategy: "package-release" as const, packageName: "@fixture/pkg", tagPattern: "^@fixture/pkg@" };
  const detected = await detectLatestVersion(client, packageSource);
  assert.equal(detected?.label, "1.0.0");
  assert.equal(detected?.refValue, "@fixture/pkg@1.0.0");
  assert.equal(detected?.refType, "tag");
});

test("changed files are scoped to the monitored promoted paths", async () => {
  const client = fakeClient({
    listReleases: async () => [{ tag_name: "v1.1.0", name: "stable", draft: false, prerelease: false, created_at: "2026-08-19T00:00:00Z", published_at: "2026-08-19T00:00:00Z", html_url: "https://github.com/example/project/releases/tag/v1.1.0", zipball_url: "https://example.com/stable.zip", target_commitish: "main" }],
    resolveRefCommit: async () => "6666666666666666666666666666666666666666",
    compareCommits: async () => ({ files: [{ filename: "skills/engineering/tdd/SKILL.md", status: "modified" }, { filename: "skills/misc/README.md", status: "modified" }] })
  });
  const promotedSource = { ...source, candidatePolicy: "promoted" as const };
  const detected = await detectLatestVersion(client, promotedSource, { label: "1.0.0", refType: "release", refValue: "v1.0.0", commitSha: "7777777777777777777777777777777777777777", monitoredPathSha256: "old", upstreamPublishedAt: "2026-08-18T00:00:00Z", officialDownloadUrl: "https://example.com", changedFiles: [] });
  assert.deepEqual(detected?.changedFiles, ["engineering/tdd/SKILL.md"]);
});

test("truncated GitHub trees fail closed", async () => {
  const client = fakeClient({ getTree: async () => ({ sha: "tree", truncated: true, tree: [] }) });
  await assert.rejects(() => detectLatestVersion(client, source), /truncada/);
});

test("git-tag detection selects the highest stable tag and ignores unchanged candidates", async () => {
  const client = fakeClient({
    listTags: async () => [
      { name: "v1.9.0", commit: { sha: "2222222222222222222222222222222222222222" }, zipball_url: "https://example.com/1.9.zip", tarball_url: "https://example.com/1.9.tgz" },
      { name: "v2.0.0-rc.1", commit: { sha: "3333333333333333333333333333333333333333" }, zipball_url: "https://example.com/rc.zip", tarball_url: "https://example.com/rc.tgz" },
      { name: "v1.10.0", commit: { sha: "4444444444444444444444444444444444444444" }, zipball_url: "https://example.com/1.10.zip", tarball_url: "https://example.com/1.10.tgz" }
    ],
    resolveRefCommit: async (_owner, _repo, ref) => ref === "v1.10.0" ? "4444444444444444444444444444444444444444" : "2222222222222222222222222222222222222222"
  });
  const tagSource = { ...source, versionStrategy: "git-tag" as const };
  const detected = await detectLatestVersion(client, tagSource);
  assert.equal(detected?.refValue, "v1.10.0");
  assert.equal(detected?.refType, "tag");
  assert.equal(await detectLatestVersion(client, tagSource, detected), null);
});
