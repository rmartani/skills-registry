import type { GitHubClient, GitHubRelease, GitHubTag, GitHubTree, NpmPackageMetadata } from "../github/github-client.js";
import { hashTreeEntries, relativeTreePath, type GitTreeEntry } from "./path-hash.js";

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

export function isExperimentalPath(filePath: string): boolean {
  return /(^|\/)(experimental|deprecated|in-progress|wip)(\/|$)/i.test(filePath);
}

function isStableRelease(release: GitHubRelease): boolean {
  return !release.draft && !release.prerelease && !isExperimentalPath(release.tag_name);
}

function isStableTag(tag: GitHubTag): boolean {
  return !/(?:^|[-_.])(alpha|beta|canary|dev|experimental|nightly|next|rc|snapshot)(?:[-_.]|$)/i.test(tag.name) && !isExperimentalPath(tag.name);
}

function isStablePackageVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(version);
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
  if (tree.truncated) throw new Error("GitHub retornou uma árvore truncada; o hash não pode ser calculado com segurança.");
  return tree.tree.filter((entry) => entry.type === "blob").map((entry) => ({ path: entry.path, sha: entry.sha, mode: entry.mode, type: "blob" as const }));
}

function candidateFilter(source: DetectionSource): (relativePath: string, entry: GitTreeEntry) => boolean {
  return (relativePath) => isCandidateAllowed(relativePath, source.includeExperimental, source.candidatePolicy);
}

function changedFilesForSource(files: string[], source: DetectionSource): string[] {
  return files
    .map((filePath) => relativeTreePath(filePath, source.monitoredPath))
    .filter((relativePath): relativePath is string => relativePath !== undefined && relativePath !== "" && isCandidateAllowed(relativePath, source.includeExperimental, source.candidatePolicy))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export async function detectLatestVersion(client: GitHubClient, source: DetectionSource, previous?: DetectedVersion): Promise<DetectedVersion | null> {
  const { owner, repo } = githubParts(source.repositoryUrl);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const filter = candidateFilter(source);
  const releaseCandidates = (await client.listReleases(owner, repo)).filter((release) => isStableRelease(release) && matchesTagPattern(release.tag_name, source.tagPattern)).sort(releaseSort);
  const tagCandidates = source.versionStrategy === "git-tag"
    ? (await client.listTags(owner, repo)).filter((tag) => isStableTag(tag) && matchesTagPattern(tag.name, source.tagPattern)).sort((a, b) => versionSort(a.name, b.name))
    : [];

  const makeDetected = async (refValue: string, refType: "release" | "tag", label: string, upstreamPublishedAt: string, officialDownloadUrl: string): Promise<DetectedVersion | null> => {
    const commitSha = await client.resolveRefCommit(owner, repo, refValue);
    const tree = treeFromResponse(await client.getTree(owner, repo, commitSha));
    const monitoredPathSha256 = hashTreeEntries(tree, source.monitoredPath, filter);
    if (previous && previous.refValue === refValue && previous.commitSha === commitSha && previous.monitoredPathSha256 === monitoredPathSha256) return null;
    let changedFiles: string[] = [];
    if (previous && previous.commitSha !== commitSha) {
      const comparison = await client.compareCommits(owner, repo, previous.commitSha, commitSha);
      changedFiles = changedFilesForSource(comparison.files.map((file) => file.filename), source);
    }
    return { label, refType, refValue, commitSha, monitoredPathSha256, upstreamPublishedAt, officialDownloadUrl, changedFiles };
  };

  if (source.versionStrategy === "package-release" && source.packageName) {
    let metadata: NpmPackageMetadata | undefined;
    try {
      metadata = await client.getNpmPackageMetadata(source.packageName);
    } catch {
      // A package registry outage must not erase or replace the existing recommendation;
      // the GitHub release fallback below still detects known package tags.
    }
    if (metadata) {
      const packageVersions = Object.keys(metadata.versions)
        .filter((version) => isStablePackageVersion(version))
        .sort(versionSort);
      for (const version of packageVersions) {
        const refValue = `${source.packageName}@${version}`;
        if (!matchesTagPattern(refValue, source.tagPattern)) continue;
        const detected = await makeDetected(refValue, "tag", version, metadata.time[version] ?? now, `https://www.npmjs.com/package/${encodeURIComponent(source.packageName)}/v/${encodeURIComponent(version)}`);
        if (detected) return detected;
        if (previous?.refValue === refValue) return null;
      }
    }
  }

  if (source.versionStrategy !== "commit-path") {
    const candidate = source.versionStrategy === "git-tag" ? tagCandidates[0] : releaseCandidates[0];
    if (candidate) {
      const refValue = "tag_name" in candidate ? candidate.tag_name : candidate.name;
      return makeDetected(
        refValue,
        source.versionStrategy === "git-tag" ? "tag" : "release",
        "tag_name" in candidate ? candidate.name || candidate.tag_name : candidate.name,
        "tag_name" in candidate ? candidate.published_at ?? candidate.created_at : now,
        "tag_name" in candidate ? candidate.html_url : `${source.repositoryUrl}/tree/${encodeURIComponent(candidate.name)}`
      );
    }
  }

  const repository = await client.getRepository(owner, repo);
  const commitSha = await client.resolveRefCommit(owner, repo, repository.default_branch);
  const tree = treeFromResponse(await client.getTree(owner, repo, commitSha));
  const monitoredPathSha256 = hashTreeEntries(tree, source.monitoredPath, filter);
  if (previous?.commitSha === commitSha && previous.monitoredPathSha256 === monitoredPathSha256) return null;
  let changedFiles: string[] = [];
  if (previous && previous.commitSha !== commitSha) {
    const comparison = await client.compareCommits(owner, repo, previous.commitSha, commitSha);
    changedFiles = changedFilesForSource(comparison.files.map((file) => file.filename), source);
  }
  return { label: commitSha.slice(0, 12), refType: "commit", refValue: commitSha, commitSha, monitoredPathSha256, upstreamPublishedAt: now, officialDownloadUrl: `${source.repositoryUrl}/tree/${commitSha}`, changedFiles };
}

export function isCandidateAllowed(pathName: string, includeExperimental: boolean, candidatePolicy: CandidatePolicy = "stable"): boolean {
  const normalized = pathName.replaceAll("\\", "/");
  if (!includeExperimental && isExperimentalPath(normalized)) return false;
  if (candidatePolicy === "opt-in" && !includeExperimental) return false;
  if (candidatePolicy !== "promoted") return true;
  const channel = normalized.split("/")[0]?.toLowerCase();
  return channel === "engineering" || channel === "productivity" || channel === "promoted";
}
