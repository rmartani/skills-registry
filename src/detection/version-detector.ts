import type { GitHubClient, GitHubRelease, GitHubTag, GitHubTree } from "../github/github-client.js";
import { hashTreeEntries, type GitTreeEntry } from "./path-hash.js";

export type VersionStrategy = "github-release" | "git-tag" | "package-release" | "commit-path";
export type CandidatePolicy = "stable" | "promoted" | "opt-in";

export interface DetectionSource {
  repositoryUrl: string;
  monitoredPath: string;
  versionStrategy: VersionStrategy;
  packageName: string | null;
  tagPattern: string | null;
  candidatePolicy: CandidatePolicy;
  includeExperimental: boolean;
}

export interface DetectedVersion {
  label: string;
  refType: "release" | "tag" | "commit";
  refValue: string;
  commitSha: string;
  monitoredPathSha256: string;
  upstreamPublishedAt: string;
  officialDownloadUrl: string;
  changedFiles: string[];
}

function isExperimentalPath(filePath: string): boolean {
  return /(^|\/)(experimental|deprecated|in-progress|wip)(\/|$)/i.test(filePath);
}

function isStableRelease(release: GitHubRelease): boolean {
  return !release.draft && !release.prerelease && !isExperimentalPath(release.tag_name);
}

function isStableTag(tag: GitHubTag): boolean {
  return !/(?:^|[-_.])(alpha|beta|canary|dev|experimental|nightly|next|rc|snapshot)(?:[-_.]|$)/i.test(tag.name) && !isExperimentalPath(tag.name);
}

function versionSort(a: string, b: string): number {
  const aNumbers = a.match(/\d+/g)?.map(Number) ?? [];
  const bNumbers = b.match(/\d+/g)?.map(Number) ?? [];
  for (let index = 0; index < Math.max(aNumbers.length, bNumbers.length); index += 1) {
    const difference = (bNumbers[index] ?? 0) - (aNumbers[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a < b ? 1 : a > b ? -1 : 0;
}

function matchesTagPattern(tag: string, pattern: string | null): boolean {
  if (!pattern) return true;
  try {
    return new RegExp(pattern).test(tag);
  } catch {
    throw new Error("tagPattern inválido no manifesto.");
  }
}

function githubParts(repositoryUrl: string): { owner: string; repo: string } {
  const url = new URL(repositoryUrl);
  if (url.protocol !== "https:" || url.hostname !== "github.com") throw new Error("A origem precisa ser um repositório GitHub HTTPS.");
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo || repo.includes(".")) throw new Error("URL de repositório GitHub inválida.");
  return { owner, repo };
}

function releaseSort(a: GitHubRelease, b: GitHubRelease): number {
  return (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at);
}

function treeFromResponse(tree: GitHubTree): GitTreeEntry[] {
  return tree.tree.filter((entry) => entry.type === "blob").map((entry) => ({ path: entry.path, sha: entry.sha, mode: entry.mode, type: "blob" as const }));
}

export async function detectLatestVersion(client: GitHubClient, source: DetectionSource, previous?: DetectedVersion): Promise<DetectedVersion | null> {
  const { owner, repo } = githubParts(source.repositoryUrl);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const releaseCandidates = (await client.listReleases(owner, repo)).filter((release) => isStableRelease(release) && matchesTagPattern(release.tag_name, source.tagPattern)).sort(releaseSort);
  const tagCandidates = source.versionStrategy === "git-tag"
    ? (await client.listTags(owner, repo)).filter((tag) => isStableTag(tag) && matchesTagPattern(tag.name, source.tagPattern)).sort((a, b) => versionSort(a.name, b.name))
    : [];

  if (source.versionStrategy !== "commit-path") {
    const candidate = source.versionStrategy === "git-tag" ? tagCandidates[0] : releaseCandidates[0];
    if (candidate) {
      const refValue = "tag_name" in candidate ? candidate.tag_name : candidate.name;
      const commitSha = await client.resolveRefCommit(owner, repo, refValue);
      const tree = treeFromResponse(await client.getTree(owner, repo, commitSha));
      const monitoredPathSha256 = hashTreeEntries(tree, source.monitoredPath);
      if (previous && previous.refValue === refValue && previous.commitSha === commitSha && previous.monitoredPathSha256 === monitoredPathSha256) return null;
      return {
        label: "tag_name" in candidate ? candidate.name || candidate.tag_name : candidate.name,
        refType: source.versionStrategy === "git-tag" ? "tag" : "release",
        refValue,
        commitSha,
        monitoredPathSha256,
        upstreamPublishedAt: "tag_name" in candidate ? candidate.published_at ?? candidate.created_at : now,
        officialDownloadUrl: "tag_name" in candidate ? candidate.html_url : `${source.repositoryUrl}/tree/${encodeURIComponent(candidate.name)}`,
        changedFiles: []
      };
    }
  }

  const repository = await client.getRepository(owner, repo);
  const commitSha = await client.resolveRefCommit(owner, repo, repository.default_branch);
  const tree = treeFromResponse(await client.getTree(owner, repo, commitSha));
  const monitoredPathSha256 = hashTreeEntries(tree, source.monitoredPath);
  if (previous?.commitSha === commitSha && previous.monitoredPathSha256 === monitoredPathSha256) return null;
  return {
    label: commitSha.slice(0, 12),
    refType: "commit",
    refValue: commitSha,
    commitSha,
    monitoredPathSha256,
    upstreamPublishedAt: now,
    officialDownloadUrl: `${source.repositoryUrl}/tree/${commitSha}`,
    changedFiles: []
  };
}

export function isCandidateAllowed(pathName: string, includeExperimental: boolean): boolean {
  return includeExperimental || !isExperimentalPath(pathName);
}
