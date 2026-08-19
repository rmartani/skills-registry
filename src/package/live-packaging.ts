import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GitHubClient } from "../github/github-client.js";
import { isCandidateAllowed } from "../detection/version-detector.js";
import { writeIndex } from "../index/build-index.js";
import { collectManifestFiles, validateRepository } from "../schema/validate.js";
import { buildDeterministicPackage, githubReleaseTag, type PackageBuildResult } from "./package-builder.js";
import { readZipArchive } from "./archive-reader.js";
import { stripArchiveRoot, validateArchiveEntries, type ArchiveEntry } from "./archive-validator.js";
import type { ResourceManifest, ResourceVersionManifest } from "./types.js";

export interface ResourceVersionFile {
  resource: ResourceManifest;
  version: ResourceVersionManifest;
  path: string;
  document: Record<string, unknown>;
}

export interface ArchiveDownloadClient {
  downloadArchive(owner: string, repo: string, ref: string): Promise<Uint8Array>;
}

export interface PreparedStagedPackage {
  resourceId: string;
  resourceSlug: string;
  versionId: string;
  artifactFileName: string;
  artifactSha256: string;
  payloadSha256: string;
  sizeBytes: number;
  githubReleaseTag: string;
}

function sourceParts(repositoryUrl: string): { owner: string; repo: string } {
  const url = new URL(repositoryUrl);
  if (url.hostname !== "github.com" || url.protocol !== "https:") throw new Error(`Origem não suportada: ${repositoryUrl}`);
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo) throw new Error(`Origem GitHub inválida: ${repositoryUrl}`);
  return { owner, repo };
}

function sourceEntries(
  entries: ArchiveEntry[],
  monitoredPath: string,
  candidatePolicy: ResourceManifest["source"]["candidatePolicy"],
  includeExperimental: boolean
): ArchiveEntry[] {
  const monitor = monitoredPath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "") || ".";
  return entries
    .filter((entry) => entry.type !== "directory")
    .map((entry) => {
      const filePath = entry.path.replaceAll("\\", "/");
      const relativePath = monitor === "." ? filePath : filePath.startsWith(`${monitor}/`) ? filePath.slice(monitor.length + 1) : undefined;
      if (!relativePath || !isCandidateAllowed(relativePath, includeExperimental, candidatePolicy)) return undefined;
      return { ...entry, path: relativePath };
    })
    .filter((entry): entry is ArchiveEntry => entry !== undefined && entry.path.length > 0);
}

export async function readResourceVersionFiles(rootDir: string): Promise<ResourceVersionFile[]> {
  const files = await collectManifestFiles(rootDir);
  const resources = new Map(
    files
      .filter((file) => file.kind === "resource")
      .map((file) => [file.id, { resource: file.document as unknown as ResourceManifest, path: file.path }])
  );
  return files
    .filter((file) => file.kind === "resource-version")
    .map((file) => {
      const version = file.document as unknown as ResourceVersionManifest;
      const resource = resources.get(version.resourceId);
      if (!resource) throw new Error(`${file.path}: resourceId não encontrado.`);
      return { resource: resource.resource, version, path: file.path, document: file.document };
    });
}

async function buildFromUpstream(
  client: ArchiveDownloadClient,
  item: ResourceVersionFile
): Promise<PackageBuildResult> {
  const { resource, version } = item;
  const { owner, repo } = sourceParts(resource.source.repositoryUrl);
  const archive = await client.downloadArchive(owner, repo, version.ref.value);
  // Symlinks outside the selected monitored payload may be present in an
  // upstream archive. They remain typed entries and are rejected if selected;
  // no symlink is copied into a package.
  const rawEntries = readZipArchive(archive, { allowSymlinks: true });
  const entries = stripArchiveRoot(rawEntries);
  const payloadEntries = sourceEntries(entries, resource.source.monitoredPath, resource.source.candidatePolicy, resource.source.includeExperimental);
  if (payloadEntries.length === 0) throw new Error(`${resource.slug}: monitoredPath não produziu arquivos.`);
  const noticeEntries = entries.filter((entry) => resource.official.license.noticePaths.includes(entry.path));
  const selectedEntries = [...new Map([...payloadEntries, ...noticeEntries].map((entry) => [entry.path, entry] as const)).values()];
  validateArchiveEntries(selectedEntries);
  const result = buildDeterministicPackage(resource, version, payloadEntries, {
    packagedAt: version.packaging.packagedAt,
    licenseEntries: noticeEntries
  });
  if (version.packaging.mode === "registry-zip") {
    if (version.packaging.artifactSha256 !== null && result.artifactSha256 !== version.packaging.artifactSha256) {
      throw new Error(`${resource.slug}: artifact SHA divergente do manifesto.`);
    }
    if (version.packaging.payloadSha256 !== null && result.payloadSha256 !== version.packaging.payloadSha256) {
      throw new Error(`${resource.slug}: payload SHA divergente do manifesto.`);
    }
    if (version.packaging.sizeBytes !== null && result.artifact.byteLength !== version.packaging.sizeBytes) {
      throw new Error(`${resource.slug}: tamanho do artifact divergente do manifesto.`);
    }
    if (result.fileName !== version.packaging.artifactFileName) {
      throw new Error(`${resource.slug}: nome do artifact divergente do manifesto.`);
    }
    if (version.packaging.githubReleaseTag !== githubReleaseTag(resource, version)) {
      throw new Error(`${resource.slug}: tag de Release divergente do manifesto.`);
    }
  }
  return result;
}

async function writeArtifact(outputDir: string, result: PackageBuildResult): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, result.fileName), result.artifact);
  await writeFile(path.join(outputDir, `${result.fileName}.sha256`), `${result.artifactSha256}  ${result.fileName}\n`);
}

export async function packageLive(
  rootDir: string,
  outputDir: string,
  client: ArchiveDownloadClient = new GitHubClient({ token: process.env.GITHUB_TOKEN })
): Promise<void> {
  const items = await readResourceVersionFiles(rootDir);
  await mkdir(outputDir, { recursive: true });
  for (const item of items) {
    const { resource, version } = item;
    if (version.packaging.mode === "link-only") {
      console.log(`SKIP ${resource.slug}@${version.label}: link-only`);
      continue;
    }
    if (version.packaging.mode === "staged") {
      console.log(`SKIP ${resource.slug}@${version.label}: staged sem artifact verificado`);
      continue;
    }
    const result = await buildFromUpstream(client, item);
    await writeArtifact(outputDir, result);
    console.log(`OK ${resource.slug}@${version.label}: ${result.fileName} ${result.artifactSha256}`);
  }
}

type RegistryZipPackaging = Extract<ResourceVersionManifest["packaging"], { mode: "registry-zip" }>;

function stagedPackaging(item: ResourceVersionFile, result: PackageBuildResult): RegistryZipPackaging {
  if (item.resource.official.license.redistribution !== "allowed") {
    throw new Error(`${item.resource.slug}: versão staged exige licença com redistribution allowed.`);
  }
  return {
    mode: "registry-zip",
    packagedAt: item.version.packaging.packagedAt,
    artifactFileName: result.fileName,
    artifactSha256: result.artifactSha256,
    payloadSha256: result.payloadSha256,
    sizeBytes: result.artifact.byteLength,
    githubReleaseTag: githubReleaseTag(item.resource, item.version)
  };
}

function serializeManifest(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Convert only explicit backend `staged` versions to fully verified registry
 * packages. All downloads are treated as archives; no upstream content is
 * executed. The repository is validated again without allowStaged before this
 * function returns.
 */
export async function prepareStagedPackages(
  rootDir: string,
  outputDir: string,
  client: ArchiveDownloadClient = new GitHubClient({ token: process.env.GITHUB_TOKEN })
): Promise<PreparedStagedPackage[]> {
  await validateRepository(rootDir, { allowStaged: true });
  const items = await readResourceVersionFiles(rootDir);
  const staged = items.filter((item) => item.version.packaging.mode === "staged");
  if (staged.length === 0) {
    await validateRepository(rootDir);
    return [];
  }

  // Build every artifact before mutating any manifest. A failed or unsafe
  // archive therefore cannot leave a partially converted publication behind.
  const built = [] as Array<{ item: ResourceVersionFile; result: PackageBuildResult; packaging: RegistryZipPackaging }>;
  for (const item of staged) {
    if (item.resource.official.license.redistribution !== "allowed") {
      throw new Error(`${item.resource.slug}: versão staged exige licença com redistribution allowed.`);
    }
    const result = await buildFromUpstream(client, item);
    built.push({ item, result, packaging: stagedPackaging(item, result) });
  }

  for (const { item, result, packaging } of built) {
    await writeArtifact(outputDir, result);
    const document = { ...item.document, packaging };
    await writeFile(path.join(rootDir, "registry", item.path), serializeManifest(document), "utf8");
  }
  await writeIndex(rootDir);
  await validateRepository(rootDir);

  return built.map(({ item, result, packaging }) => ({
    resourceId: item.resource.id,
    resourceSlug: item.resource.slug,
    versionId: item.version.id,
    artifactFileName: result.fileName,
    artifactSha256: result.artifactSha256,
    payloadSha256: result.payloadSha256,
    sizeBytes: result.artifact.byteLength,
    githubReleaseTag: packaging.githubReleaseTag
  }));
}
