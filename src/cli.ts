import { fileURLToPath } from "node:url";
import path from "node:path";
import { GitHubClient } from "./github/github-client.js";
import { writeIndex } from "./index/build-index.js";
import { packageLive, prepareStagedPackages, readResourceVersionFiles } from "./package/live-packaging.js";
import { RegistryValidationError, validateRepository } from "./schema/validate.js";
import { resolveInitialProjects } from "./seed/resolve-initial-projects.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage(): never {
  throw new Error("Uso: validate [--allow-staged] | index | package:dry-run [--live] [--allow-staged] [--output <dir>] | package:prepare [--output <dir>] | seed:resolve");
}

async function packageDryRun(args: string[]): Promise<void> {
  const allowStaged = args.includes("--allow-staged") || process.env.REGISTRY_ALLOW_STAGED === "true";
  await validateRepository(rootDir, { allowStaged });
  const live = args.includes("--live");
  const outputIndex = args.indexOf("--output");
  const outputArg = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  const outputDir = outputArg ? path.resolve(outputArg) : path.join(rootDir, ".generated", "packages");
  if (live) {
    await packageLive(rootDir, outputDir);
    return;
  }
  const items = await readResourceVersionFiles(rootDir);
  for (const { resource, version } of items) {
    if (version.packaging.mode === "registry-zip") {
      if (!version.packaging.artifactSha256 || !version.packaging.payloadSha256 || !version.packaging.artifactFileName) throw new Error(`${resource.slug}: metadados de pacote incompletos.`);
      console.log(`DRY-RUN ${resource.slug}@${version.label}: ${version.packaging.artifactFileName} (${version.packaging.artifactSha256})`);
    } else if (version.packaging.mode === "staged") {
      console.log(`DRY-RUN ${resource.slug}@${version.label}: staged (sem asset até pós-merge)`);
    } else {
      console.log(`DRY-RUN ${resource.slug}@${version.label}: link-only`);
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
      const summary = await validateRepository(rootDir, { allowStaged: args.includes("--allow-staged") || process.env.REGISTRY_ALLOW_STAGED === "true" });
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
    case "package:prepare": {
      const outputIndex = args.indexOf("--output");
      const outputArg = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
      const outputDir = outputArg ? path.resolve(outputArg) : path.join(rootDir, ".generated", "packages");
      const prepared = await prepareStagedPackages(rootDir, outputDir);
      console.log(`Staged convertido: ${prepared.length} pacote(s).`);
      return;
    }
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
