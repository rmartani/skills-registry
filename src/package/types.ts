export interface ResourceLicense {
  spdx: string;
  name: string;
  url: string;
  redistribution: "allowed" | "link-only";
  noticePaths: string[];
}

export interface ResourceSource {
  repositoryUrl: string;
  monitoredPath: string;
  versionStrategy: "github-release" | "git-tag" | "package-release" | "commit-path";
  packageName: string | null;
  tagPattern: string | null;
  candidatePolicy: "stable" | "promoted" | "opt-in";
  includeExperimental: boolean;
}

export interface ResourceManifest {
  schemaVersion: "1.0.0";
  kind: "resource";
  id: string;
  projectId: string;
  collectionId: string | null;
  slug: string;
  type: "skill" | "skill-pack" | "mcp-server" | "plugin" | "prompt-pack";
  publication: { status: "active" | "deprecated"; publishedAt: string; archivedAt: string | null };
  official: { name: string; description: string; homepageUrl: string; repositoryUrl: string; maintainer: { name: string; url: string }; license: ResourceLicense };
  editorial: { descriptionPtBr: string; notesPtBr: string | null; tags: string[] };
  source: ResourceSource;
  installationVariants: Array<{ key: string; target: string; label: string; kind: "command" | "url" | "steps"; command: string | null; url: string | null; steps: string[] | null; warningPtBr: string | null; officialSourceUrl: string }>;
  recommendedVersionId: string;
}

export interface ResourceVersionManifest {
  schemaVersion: "1.0.0";
  kind: "resource-version";
  id: string;
  resourceId: string;
  label: string;
  ref: { type: "release" | "tag" | "commit"; value: string; commitSha: string };
  monitoredPathSha256: string;
  upstreamPublishedAt: string;
  approvedAt: string;
  officialDownloadUrl: string;
  packaging:
    | { mode: "registry-zip"; packagedAt: string; artifactFileName: string; artifactSha256: string; payloadSha256: string; sizeBytes: number; githubReleaseTag: string }
    | { mode: "link-only"; packagedAt: string; artifactFileName: null; artifactSha256: null; payloadSha256: null; sizeBytes: null; githubReleaseTag: null }
    | { mode: "staged"; packagedAt: string; artifactFileName: null; artifactSha256: null; payloadSha256: null; sizeBytes: null; githubReleaseTag: null };
}
