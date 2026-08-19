export interface GitHubRelease {
  tag_name: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string | null;
  html_url: string;
  zipball_url: string;
  target_commitish: string;
}

export interface GitHubRepository {
  full_name: string;
  default_branch: string;
  html_url: string;
  license: { spdx_id: string | null } | null;
}

export interface GitHubTag {
  name: string;
  commit: { sha: string };
  zipball_url: string;
  tarball_url: string;
}

export interface GitHubTree {
  sha: string;
  truncated: boolean;
  tree: Array<{ path: string; mode: string; type: "blob" | "tree" | "commit"; sha: string; size?: number; url?: string }>;
}

export interface GitHubComparison {
  files: Array<{ filename: string; status: string; additions?: number; deletions?: number; changes?: number }>;
}

export interface NpmPackageMetadata {
  name: string;
  versions: Record<string, Record<string, unknown>>;
  time: Record<string, string>;
}

export interface GitHubContent {
  path: string;
  type: "file" | "dir";
  encoding?: string;
  content?: string;
  download_url?: string | null;
}

export class GitHubClient {
  private readonly apiBaseUrl: string;
  private readonly token: string | undefined;

  constructor(options: { token?: string | undefined; apiBaseUrl?: string | undefined } = {}) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.token = options.token;
  }

  private async request<T>(requestPath: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/vnd.github+json");
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    headers.set("User-Agent", "stancatti-skills-registry/0.1");
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    const response = await fetch(`${this.apiBaseUrl}${requestPath}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(`GitHub respondeu ${response.status} para ${requestPath}.`);
    }
    return (await response.json()) as T;
  }

  async getRepository(owner: string, repo: string): Promise<GitHubRepository> {
    return this.request<GitHubRepository>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  }

  async listReleases(owner: string, repo: string): Promise<GitHubRelease[]> {
    return this.request<GitHubRelease[]>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=100`);
  }

  async listTags(owner: string, repo: string): Promise<GitHubTag[]> {
    return this.request<GitHubTag[]>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tags?per_page=100`);
  }

  async resolveRefCommit(owner: string, repo: string, ref: string): Promise<string> {
    const response = await this.request<{ object: { sha: string; type: string } }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/${encodeURIComponent(`tags/${ref}`)}`).catch(async () => {
      return this.request<{ object: { sha: string; type: string } }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/${encodeURIComponent(`heads/${ref}`)}`);
    });
    if (response.object.type === "tag") {
      const tag = await this.request<{ object: { sha: string } }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/tags/${response.object.sha}`);
      return tag.object.sha;
    }
    return response.object.sha;
  }

  async getTree(owner: string, repo: string, ref: string): Promise<GitHubTree> {
    return this.request<GitHubTree>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  }

  async compareCommits(owner: string, repo: string, base: string, head: string): Promise<GitHubComparison> {
    return this.request<GitHubComparison>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  }

  async getNpmPackageMetadata(packageName: string): Promise<NpmPackageMetadata> {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
      headers: { Accept: "application/json", "User-Agent": "stancatti-skills-registry/0.1" },
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`npm registry respondeu ${response.status}.`);
    return (await response.json()) as NpmPackageMetadata;
  }

  async getContent(owner: string, repo: string, contentPath: string, ref?: string): Promise<GitHubContent> {
    const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    return this.request<GitHubContent>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${contentPath.split("/").map(encodeURIComponent).join("/")}${suffix}`);
  }

  async downloadArchive(owner: string, repo: string, ref: string): Promise<Uint8Array> {
    const response = await fetch(`${this.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zipball/${encodeURIComponent(ref)}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "stancatti-skills-registry/0.1",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      },
      redirect: "follow",
      signal: AbortSignal.timeout(120_000)
    });
    if (!response.ok) throw new Error(`GitHub archive respondeu ${response.status}.`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
