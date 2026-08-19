import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GitHubClient } from "../github/github-client.js";

export interface SeedSpec {
  url: string;
  policy: "stable" | "promoted" | "opt-in";
  includeExperimental: boolean;
  independentVersionStreams?: boolean;
  includeHostedCorpus?: boolean;
}

export interface SeedResolution {
  schemaVersion: "1.0.0";
  kind: "seed-resolution";
  sourceUrl: string;
  resolvedAt: string;
  policy: SeedSpec["policy"];
  includeExperimental: boolean;
  independentVersionStreams: boolean;
  includeHostedCorpus: boolean;
  repository: { fullName: string; defaultBranch: string; license: string | null };
  stableReleases: Array<{ tag: string; name: string | null; publishedAt: string; url: string; zipballUrl: string }>;
}

function slugForRepository(repo: string): string {
  const slug = repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new Error(`Não foi possível gerar slug para ${repo}.`);
  return slug;
}

export async function resolveInitialProjects(rootDir: string, client: GitHubClient, resolvedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")): Promise<SeedResolution[]> {
  const specs = JSON.parse((await readFile(path.join(rootDir, "seed", "initial-projects.json"))).toString("utf8")) as SeedSpec[];
  const outputDir = path.join(rootDir, ".generated", "seed");
  await mkdir(outputDir, { recursive: true });
  const resolutions: SeedResolution[] = [];
  for (const spec of specs) {
    const url = new URL(spec.url);
    if (url.protocol !== "https:" || url.hostname !== "github.com") throw new Error(`Seed URL precisa ser GitHub HTTPS: ${spec.url}`);
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repo) throw new Error(`Seed URL inválida: ${spec.url}`);
    const repository = await client.getRepository(owner, repo);
    const releases = (await client.listReleases(owner, repo)).filter((release) => !release.draft && !release.prerelease);
    const resolution: SeedResolution = {
      schemaVersion: "1.0.0",
      kind: "seed-resolution",
      sourceUrl: spec.url,
      resolvedAt,
      policy: spec.policy,
      includeExperimental: spec.includeExperimental,
      independentVersionStreams: spec.independentVersionStreams ?? false,
      includeHostedCorpus: spec.includeHostedCorpus ?? false,
      repository: { fullName: repository.full_name, defaultBranch: repository.default_branch, license: repository.license?.spdx_id ?? null },
      stableReleases: releases.map((release) => ({ tag: release.tag_name, name: release.name, publishedAt: release.published_at ?? release.created_at, url: release.html_url, zipballUrl: release.zipball_url }))
    };
    await writeFile(path.join(outputDir, `${slugForRepository(repo)}.json`), `${JSON.stringify(resolution, null, 2)}\n`, "utf8");
    resolutions.push(resolution);
  }
  return resolutions;
}
