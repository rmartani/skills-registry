import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { GitHubClient } from "./github/github-client.js";
import { isCandidateAllowed } from "./detection/version-detector.js";
import { writeIndex } from "./index/build-index.js";
import { readZipArchive } from "./package/archive-reader.js";
import { buildDeterministicPackage } from "./package/package-builder.js";
import { stripArchiveRoot, validateArchiveEntries, type ArchiveEntry } from "./package/archive-validator.js";
import { collectManifestFiles, RegistryValidationError, validateRepository } from "./schema/validate.js";
import type { ResourceManifest, ResourceVersionManifest } from "./package/types.js";
import { resolveInitialProjects } from "./seed/resolve-initial-projects.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage(): never {
  throw new Error("Uso: validate | index | package:dry-run [--live] [--output <dir>] | seed:resolve");
}

async function readResourceManifests(): Promise<Array<{ resource: ResourceManifest; version: ResourceVersionManifest }>> {
  const files = await collectManifestFiles(rootDir);
  const versions = new Map(files.filter((file) => file.kind === "resource-version").map((file) => [file.id, file.document as unknown as ResourceVersionManifest]));
  return files
    .filter((file) => file.kind === "resource")
    .map((file) => {
      const resource = file.document as unknown as ResourceManifest;
      const version = versions.get(resource.recommendedVersionId);
      if (!version) throw new Error(`${file.path}: recommendedVersionId não encontrado.`);
      return { resource, version };
    });
}

function sourceParts(repositoryUrl: string): { owner: string; repo: string } {
  const url = new URL(repositoryUrl);
  if (url.hostname !== "github.com" || url.protocol !== "https:") throw new Error(`Origem não suportada: ${repositoryUrl}`);
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo) throw new Error(`Origem GitHub inválida: ${repositoryUrl}`);
  return { owner, repo };
}

function sourceEntries(entries: ArchiveEntry[], monitoredPath: string, candidatePolicy: ResourceManifest["source"]["candidatePolicy"], includeExperimental: boolean): ArchiveEntry[] {
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

async function packageLive(outputDir: string): Promise<void> {
  const client = new GitHubClient({ token: process.env.GITHUB_TOKEN });
  const items = await readResourceManifests();
  await mkdir(outputDir, { recursive: true });
  for (const { resource, version } of items) {
    if (version.packaging.mode === "link-only") {
      console.log(`SKIP ${resource.slug}: link-only`);
      continue;
    }
    const { owner, repo } = sourceParts(resource.source.repositoryUrl);
    const archive = await client.downloadArchive(owner, repo, version.ref.value);
    // Symlinks may exist outside the monitored payload (for example an upstream
    // root AGENTS.md alias). Keep them as typed entries; the selected payload
    // is validated strictly below and can never contain a symlink.
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
    if (version.packaging.artifactSha256 && result.artifactSha256 !== version.packaging.artifactSha256) {
      throw new Error(`${resource.slug}: artifact SHA divergente do manifesto.`);
    }
    if (version.packaging.payloadSha256 && result.payloadSha256 !== version.packaging.payloadSha256) {
      throw new Error(`${resource.slug}: payload SHA divergente do manifesto.`);
    }
    await writeFile(path.join(outputDir, result.fileName), result.artifact);
    await writeFile(path.join(outputDir, `${result.fileName}.sha256`), `${result.artifactSha256}  ${result.fileName}\n`);
    console.log(`OK ${resource.slug}: ${result.fileName} ${result.artifactSha256}`);
  }
}

async function packageDryRun(args: string[]): Promise<void> {
  await validateRepository(rootDir);
  const live = args.includes("--live");
  const outputIndex = args.indexOf("--output");
  const outputArg = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  const outputDir = outputArg ? path.resolve(outputArg) : path.join(rootDir, ".generated", "packages");
  if (live) {
    await packageLive(outputDir);
    return;
  }
  const items = await readResourceManifests();
  for (const { resource, version } of items) {
    if (version.packaging.mode === "registry-zip") {
      if (!version.packaging.artifactSha256 || !version.packaging.payloadSha256 || !version.packaging.artifactFileName) throw new Error(`${resource.slug}: metadados de pacote incompletos.`);
      console.log(`DRY-RUN ${resource.slug}: ${version.packaging.artifactFileName} (${version.packaging.artifactSha256})`);
    } else {
      console.log(`DRY-RUN ${resource.slug}: link-only`);
    }
  }
  console.log("Dry-run seguro: nenhum conteúdo upstream foi baixado ou executado. Use --live apenas para reconstruir assets em CI.");
}

async function seedResolve(): Promise<void> {
  const client = new GitHubClient({ token: process.env.GITHUB_TOKEN });
  const resolutions = await resolveInitialProjects(rootDir, client);
  for (const resolution of resolutions) console.log(`RESOLVED ${resolution.sourceUrl}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "validate": {
      const summary = await validateRepository(rootDir);
      console.log(`Validação OK: ${summary.manifests} manifestos, ${summary.resources} Resources, ${summary.versions} versões.`);
      return;
    }
    case "index": {
      const index = await writeIndex(rootDir);
      console.log(`Índice gerado: ${index.entries.length} entradas.`);
      return;
    }
    case "package:dry-run":
      await packageDryRun(args);
      return;
    case "seed:resolve":
      await seedResolve();
      return;
    default:
      usage();
  }
}

main().catch((error: unknown) => {
  if (error instanceof RegistryValidationError) {
    console.error(`Validação falhou:\n${error.message}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
