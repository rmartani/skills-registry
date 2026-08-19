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

function fakeClient(overrides: Partial<Record<"getRepository" | "listReleases" | "listTags" | "resolveRefCommit" | "getTree", (...args: never[]) => unknown>> = {}): GitHubClient {
  return {
    getRepository: overrides.getRepository ?? (async () => ({ full_name: "example/project", default_branch: "main", html_url: "https://github.com/example/project", license: { spdx_id: "MIT" } })),
    listReleases: overrides.listReleases ?? (async () => []),
    listTags: overrides.listTags ?? (async () => []),
    resolveRefCommit: overrides.resolveRefCommit ?? (async () => "1111111111111111111111111111111111111111"),
    getTree: overrides.getTree ?? (async () => ({ sha: "tree", truncated: false, tree: [{ path: "skills/SKILL.md", mode: "100644", type: "blob", sha: "blob" }] }))
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
