import { createRequire } from "node:module";
import type { ErrorObject, ValidateFunction } from "ajv";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type ManifestKind =
  | "project"
  | "collection"
  | "resource"
  | "resource-version"
  | "collection-version";

export type RegistryDocument = Record<string, unknown>;

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default as typeof import("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats").default as typeof import("ajv-formats").default;

const SCHEMA_BY_KIND: Record<ManifestKind, string> = {
  project: "project.schema.json",
  collection: "collection.schema.json",
  resource: "resource.schema.json",
  "resource-version": "resource-version.schema.json",
  "collection-version": "collection-version.schema.json"
};

const TOP_LEVEL_SCHEMAS = [
  "index.schema.json",
  "redirects.schema.json",
  "package-provenance.schema.json",
  "catalog-proposal.schema.json"
] as const;

export interface ValidationIssue {
  path: string;
  message: string;
}

export class RegistryValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[] | ValidationIssue | string) {
    const normalized = typeof issues === "string" ? [{ path: "$", message: issues }] : Array.isArray(issues) ? issues : [issues];
    super(normalized.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    this.name = "RegistryValidationError";
    this.issues = normalized;
  }
}

export interface ManifestFile {
  path: string;
  kind: ManifestKind;
  id: string;
  document: RegistryDocument;
  bytes: Buffer;
}

export interface ValidationSummary {
  manifests: number;
  projects: number;
  collections: number;
  resources: number;
  versions: number;
  redirects: number;
}

function isRecord(value: unknown): value is RegistryDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function schemaErrorPath(error: ErrorObject): string {
  if (error.instancePath) return error.instancePath;
  const missing = error.params as { missingProperty?: string };
  return missing.missingProperty ? `/${missing.missingProperty}` : "/";
}

async function listJsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listJsonFiles(absolute)));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(absolute);
  }
  return files;
}

export function manifestKindFromPath(relativePath: string): ManifestKind | undefined {
  const normalized = relativePath.replaceAll(path.sep, "/");
  if (/^projects\/[^/]+\/project\.json$/.test(normalized)) return "project";
  if (/^projects\/[^/]+\/collections\/[^/]+\.json$/.test(normalized)) return "collection";
  if (/^projects\/[^/]+\/resources\/[^/]+\/resource\.json$/.test(normalized)) return "resource";
  if (/^projects\/[^/]+\/resources\/[^/]+\/versions\/[^/]+\.json$/.test(normalized)) return "resource-version";
  if (/^projects\/[^/]+\/collections\/[^/]+\/versions\/[^/]+\.json$/.test(normalized)) return "collection-version";
  if (/^projects\/[^/]+\/collections\/versions\/[^/]+\.json$/.test(normalized)) return "collection-version";
  return undefined;
}

export async function collectManifestFiles(rootDir: string): Promise<ManifestFile[]> {
  const registryDir = path.join(rootDir, "registry", "projects");
  const absoluteFiles = await listJsonFiles(registryDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files: ManifestFile[] = [];
  for (const absolute of absoluteFiles) {
    const relativePath = path.relative(path.join(rootDir, "registry"), absolute).replaceAll(path.sep, "/");
    const kind = manifestKindFromPath(relativePath);
    if (!kind) continue;
    const bytes = await readFile(absolute);
    let document: unknown;
    try {
      document = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new RegistryValidationError({
        path: relativePath,
        message: `JSON inválido: ${error instanceof Error ? error.message : String(error)}`
      });
    }
    if (!isRecord(document)) {
      throw new RegistryValidationError({ path: relativePath, message: "O documento deve ser um objeto JSON." });
    }
    const id = stringValue(document.id);
    if (!id) throw new RegistryValidationError({ path: relativePath, message: "O campo id é obrigatório para manifestos." });
    files.push({ path: relativePath, kind, id, document, bytes });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function createSchemaValidators(rootDir: string): Promise<Map<string, ValidateFunction<unknown>>> {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictSchema: true, allowUnionTypes: true });
  addFormats(ajv);
  const schemaDir = path.join(rootDir, "schemas");
  const schemas = [...Object.values(SCHEMA_BY_KIND), ...TOP_LEVEL_SCHEMAS];
  for (const fileName of schemas) {
    const schema = JSON.parse((await readFile(path.join(schemaDir, fileName))).toString("utf8")) as object;
    ajv.addSchema(schema);
  }
  const validators = new Map<string, ValidateFunction<unknown>>();
  for (const [kind, fileName] of Object.entries(SCHEMA_BY_KIND)) {
    validators.set(kind, ajv.getSchema(`https://registry.stancatti.dev/schemas/${fileName}`)!);
  }
  for (const fileName of TOP_LEVEL_SCHEMAS) {
    validators.set(fileName, ajv.getSchema(`https://registry.stancatti.dev/schemas/${fileName}`)!);
  }
  return validators;
}

function validateDocument(
  validators: Map<string, ValidateFunction<unknown>>,
  schemaKey: string,
  document: unknown,
  relativePath: string,
  issues: ValidationIssue[]
): void {
  const validator = validators.get(schemaKey);
  if (!validator) throw new Error(`Schema não carregado: ${schemaKey}`);
  if (validator(document)) return;
  for (const error of validator.errors ?? []) {
    issues.push({ path: `${relativePath}${schemaErrorPath(error)}`, message: error.message ?? "documento inválido" });
  }
}

function addIssue(issues: ValidationIssue[], pathName: string, message: string): void {
  issues.push({ path: pathName, message });
}

function asSet(values: unknown[]): Set<string> {
  return new Set(values.filter((value): value is string => typeof value === "string"));
}

export async function validateRepository(rootDir: string): Promise<ValidationSummary> {
  const issues: ValidationIssue[] = [];
  const validators = await createSchemaValidators(rootDir);
  const files = await collectManifestFiles(rootDir);
  const byKind = new Map<ManifestKind, ManifestFile[]>();
  for (const file of files) {
    const list = byKind.get(file.kind) ?? [];
    list.push(file);
    byKind.set(file.kind, list);
    validateDocument(validators, file.kind, file.document, file.path, issues);
  }

  const indexPath = path.join(rootDir, "registry", "index.json");
  const redirectsPath = path.join(rootDir, "registry", "redirects.json");
  let index: RegistryDocument | undefined;
  let redirects: RegistryDocument | undefined;
  try {
    index = JSON.parse((await readFile(indexPath)).toString("utf8")) as RegistryDocument;
    validateDocument(validators, "index.schema.json", index, "registry/index.json", issues);
  } catch (error) {
    addIssue(issues, "registry/index.json", `não pôde ser lido: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    redirects = JSON.parse((await readFile(redirectsPath)).toString("utf8")) as RegistryDocument;
    validateDocument(validators, "redirects.schema.json", redirects, "registry/redirects.json", issues);
  } catch (error) {
    addIssue(issues, "registry/redirects.json", `não pôde ser lido: ${error instanceof Error ? error.message : String(error)}`);
  }

  const projects = byKind.get("project") ?? [];
  const collections = byKind.get("collection") ?? [];
  const resources = byKind.get("resource") ?? [];
  const resourceVersions = byKind.get("resource-version") ?? [];
  const collectionVersions = byKind.get("collection-version") ?? [];
  const ids = new Map<string, string>();
  const slugs = new Map<string, string>();
  const projectById = new Map<string, ManifestFile>();
  const collectionById = new Map<string, ManifestFile>();
  const resourceById = new Map<string, ManifestFile>();
  const resourceBySlug = new Map<string, ManifestFile>();
  const collectionVersionById = new Map<string, ManifestFile>();
  const resourceVersionById = new Map<string, ManifestFile>();

  for (const file of files) {
    const existingId = ids.get(file.id);
    if (existingId) addIssue(issues, file.path, `id duplicado; já usado em ${existingId}`);
    else ids.set(file.id, file.path);
    const slug = stringValue(file.document.slug);
    if (slug) {
      const existingSlug = slugs.get(slug);
      if (existingSlug) addIssue(issues, file.path, `slug global duplicado; já usado em ${existingSlug}`);
      else slugs.set(slug, file.path);
    }
    if (file.kind === "project") projectById.set(file.id, file);
    if (file.kind === "collection") collectionById.set(file.id, file);
    if (file.kind === "resource") {
      resourceById.set(file.id, file);
      if (slug) resourceBySlug.set(slug, file);
    }
    if (file.kind === "resource-version") resourceVersionById.set(file.id, file);
    if (file.kind === "collection-version") collectionVersionById.set(file.id, file);
  }

  for (const file of projects) {
    const slug = stringValue(file.document.slug);
    if (slug && file.path !== `projects/${slug}/project.json`) addIssue(issues, file.path, "path não corresponde ao slug do Project.");
  }
  for (const file of collections) {
    const document = file.document;
    const slug = stringValue(document.slug);
    const projectId = stringValue(document.projectId);
    if (slug && projectId) {
      const project = projectById.get(projectId);
      if (!project) addIssue(issues, file.path, `projectId ${projectId} não existe.`);
      else {
        const projectSlug = stringValue(project.document.slug);
        if (projectSlug && file.path !== `projects/${projectSlug}/collections/${slug}.json`) addIssue(issues, file.path, "path não corresponde ao Project/Collection.");
      }
    }
    for (const resourceId of arrayValue(document.resourceIds)) {
      if (typeof resourceId === "string" && !resourceById.has(resourceId)) addIssue(issues, file.path, `resourceId ${resourceId} não existe.`);
    }
    const recommended = document.recommendedCollectionVersionId;
    if (typeof recommended === "string") {
      const version = collectionVersionById.get(recommended);
      if (!version) addIssue(issues, file.path, `recommendedCollectionVersionId ${recommended} não existe.`);
      else if (version.document.collectionId !== file.id) addIssue(issues, file.path, "recommendedCollectionVersionId pertence a outra Collection.");
    }
  }
  for (const file of resources) {
    const document = file.document;
    const slug = stringValue(document.slug);
    const projectId = stringValue(document.projectId);
    const collectionId = typeof document.collectionId === "string" ? document.collectionId : undefined;
    if (slug && projectId) {
      const project = projectById.get(projectId);
      if (!project) addIssue(issues, file.path, `projectId ${projectId} não existe.`);
      else {
        const projectSlug = stringValue(project.document.slug);
        if (projectSlug && file.path !== `projects/${projectSlug}/resources/${slug}/resource.json`) addIssue(issues, file.path, "path não corresponde ao Project/Resource.");
      }
    }
    if (collectionId) {
      const collection = collectionById.get(collectionId);
      if (!collection) addIssue(issues, file.path, `collectionId ${collectionId} não existe.`);
      else if (collection.document.projectId !== projectId) addIssue(issues, file.path, "Collection e Resource pertencem a Projects diferentes.");
    }
    const recommended = document.recommendedVersionId;
    const version = resourceVersionById.get(typeof recommended === "string" ? recommended : "");
    if (!version) addIssue(issues, file.path, `recommendedVersionId ${String(recommended)} não existe.`);
    else if (version.document.resourceId !== file.id) addIssue(issues, file.path, "recommendedVersionId pertence a outro Resource.");
  }
  for (const file of resourceVersions) {
    const resourceId = stringValue(file.document.resourceId);
    const resource = resourceId ? resourceById.get(resourceId) : undefined;
    if (!resource) addIssue(issues, file.path, `resourceId ${String(resourceId)} não existe.`);
    else {
      const resourceSlug = stringValue(resource.document.slug);
      const project = projectById.get(String(resource.document.projectId));
      const projectSlug = project ? stringValue(project.document.slug) : undefined;
      const expectedPrefix = projectSlug && resourceSlug ? `projects/${projectSlug}/resources/${resourceSlug}/versions/` : "";
      if (expectedPrefix && !file.path.startsWith(expectedPrefix)) addIssue(issues, file.path, "path não corresponde ao Resource.");
    }
    const basename = path.posix.basename(file.path, ".json");
    if (basename !== file.id) addIssue(issues, file.path, "nome do arquivo de versão deve ser o id canônico.");
    if (resource) {
      const official = isRecord(resource.document.official) ? resource.document.official : undefined;
      const license = official && isRecord(official.license) ? official.license : undefined;
      const packaging = isRecord(file.document.packaging) ? file.document.packaging : undefined;
      if (license?.redistribution === "link-only" && packaging?.mode !== "link-only") addIssue(issues, file.path, "licença link-only exige packaging.mode link-only.");
      if (packaging?.mode === "registry-zip" && license?.redistribution !== "allowed") addIssue(issues, file.path, "registry-zip exige licença com redistribution allowed.");
    }
  }
  for (const file of collectionVersions) {
    const collectionId = stringValue(file.document.collectionId);
    const collection = collectionId ? collectionById.get(collectionId) : undefined;
    if (!collection) addIssue(issues, file.path, `collectionId ${String(collectionId)} não existe.`);
    else {
      const project = projectById.get(String(collection.document.projectId));
      const projectSlug = project ? stringValue(project.document.slug) : undefined;
      const collectionSlug = stringValue(collection.document.slug);
      const canonicalPrefix = projectSlug && collectionSlug ? `projects/${projectSlug}/collections/${collectionSlug}/versions/` : "";
      const legacyPrefix = projectSlug ? `projects/${projectSlug}/collections/versions/` : "";
      if (canonicalPrefix && !file.path.startsWith(canonicalPrefix) && !file.path.startsWith(legacyPrefix)) addIssue(issues, file.path, "path não corresponde à Collection.");
    }
    const resourceIds = asSet(arrayValue(file.document.resourceVersionIds));
    for (const resourceVersionId of resourceIds) {
      const resourceVersion = resourceVersionById.get(resourceVersionId);
      if (!resourceVersion) addIssue(issues, file.path, `resourceVersionId ${resourceVersionId} não existe.`);
    }
    const basename = path.posix.basename(file.path, ".json");
    if (basename !== file.id) addIssue(issues, file.path, "nome do arquivo de versão deve ser o id canônico.");
  }

  const collectionResourceReferences = new Set<string>();
  for (const file of collections) for (const id of asSet(arrayValue(file.document.resourceIds))) collectionResourceReferences.add(id);
  for (const resource of resources) {
    const collectionId = resource.document.collectionId;
    if (typeof collectionId === "string" && !collectionResourceReferences.has(resource.id)) addIssue(issues, resource.path, "Resource não está listado na Collection declarada.");
  }

  if (index) {
    const expectedEntries = files.map((file) => ({ path: file.path, kind: file.kind, id: file.id, sha256: createHash("sha256").update(file.bytes).digest("hex") }));
    const actualEntries = arrayValue(index.entries);
    if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) addIssue(issues, "registry/index.json", "índice divergente; execute npm run index.");
  }

  if (redirects) {
    const redirectItems = arrayValue(redirects.redirects);
    const redirectGraph = new Map<string, string>();
    for (const item of redirectItems) {
      if (!isRecord(item)) continue;
      const from = stringValue(item.from);
      const to = stringValue(item.to);
      const resourceId = stringValue(item.resourceId);
      if (!from || !to || !resourceId) continue;
      if (from === to) addIssue(issues, "registry/redirects.json", `redirect ${from} aponta para si mesmo.`);
      if (!resourceBySlug.has(to)) addIssue(issues, "registry/redirects.json", `destino ${to} não é um Resource existente.`);
      const resource = resourceById.get(resourceId);
      if (!resource) addIssue(issues, "registry/redirects.json", `resourceId ${resourceId} não existe.`);
      else if (resource.document.slug !== to) addIssue(issues, "registry/redirects.json", `redirect ${from} não corresponde ao Resource ${to}.`);
      if (resourceBySlug.has(from)) addIssue(issues, "registry/redirects.json", `origem ${from} já é slug canônico.`);
      redirectGraph.set(from, to);
    }
    for (const from of redirectGraph.keys()) {
      const seen = new Set<string>();
      let current: string | undefined = from;
      while (current && redirectGraph.has(current)) {
        if (seen.has(current)) {
          addIssue(issues, "registry/redirects.json", `ciclo detectado a partir de ${from}.`);
          break;
        }
        seen.add(current);
        current = redirectGraph.get(current);
      }
    }
  }

  if (issues.length > 0) throw new RegistryValidationError(issues);
  return {
    manifests: files.length,
    projects: projects.length,
    collections: collections.length,
    resources: resources.length,
    versions: resourceVersions.length + collectionVersions.length,
    redirects: redirects && Array.isArray(redirects.redirects) ? redirects.redirects.length : 0
  };
}

export { SCHEMA_BY_KIND };
