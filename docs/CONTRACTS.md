# Contratos do Skills Registry

## Manifestos

Todos os JSON canônicos usam JSON Schema draft 2020-12, `schemaVersion: "1.0.0"`, UUID strings e `additionalProperties: false`. URLs externas devem ser HTTPS e slugs seguem `^[a-z0-9]+(?:-[a-z0-9]+)*$`.

A árvore canônica é:

```text
registry/index.json
registry/redirects.json
registry/projects/{projectSlug}/project.json
registry/projects/{projectSlug}/collections/{collectionSlug}.json
registry/projects/{projectSlug}/resources/{resourceSlug}/resource.json
registry/projects/{projectSlug}/resources/{resourceSlug}/versions/{versionId}.json
```

O slug é globalmente único e fica bloqueado depois da primeira publicação. Um redirect excepcional registra `from`, `to`, `resourceId` e `reason`; o destino deve existir e a cadeia não pode formar ciclo.

### Estados

O manifesto canônico guarda apenas `publication.status` `active|deprecated`. Os estados operacionais `draft`, `update_available` e `unavailable` são projeções do backend:

1. sem versão aprovada → `draft`;
2. `archived_at` → `deprecated`;
3. três falhas consecutivas → `unavailable`;
4. candidato `pending`/`pr_open` mais novo → `update_available`;
5. caso contrário → `active`.

Detecção não muda `recommendedVersionId`. Aprovação cria uma PR; somente merge em `main` seguido de reconcile torna a versão pública.

## Index

`registry/index.json` contém somente manifestos sob `registry/projects`. Cada entrada tem `path`, `kind`, `id` e SHA-256 dos bytes exatos do arquivo. Entradas são ordenadas por comparação lexical de bytes/código Unicode do caminho. Não há timestamp de geração; portanto duas gerações sem mudanças produzem bytes idênticos.

```json
{ "schemaVersion": "1.0.0", "kind": "registry-index", "entries": [] }
```

`npm run validate` também compara o índice com a árvore atual e falha para IDs/paths/referências órfãos, slug duplicado, recommended ID de outro Resource ou redirect inválido.

## Versionamento e detecção

`source.versionStrategy` pode ser `github-release`, `git-tag`, `package-release` ou `commit-path`; `candidatePolicy` pode ser `stable`, `promoted` ou `opt-in`. Releases draft/prerelease e paths `experimental`, `deprecated`, `in-progress` ou `wip` ficam fora por padrão.

Quando não há release apropriada, o detector usa commit e hash do caminho monitorado. O hash é SHA-256 da sequência ordenada:

```text
relativePath + NUL + blobSha + NUL + gitMode
```

O caminho é relativo a `monitoredPath`, `/` é o separador e a ordenação não depende de locale. Um commit que não muda essa sequência não cria candidato.

## Pacotes e checksums

O pacote ZIP é criado sem executar o conteúdo. Caminhos são lexicalmente ordenados, o timestamp ZIP vem de `packaging.packagedAt`, modos são normalizados e a proveniência é adicionada em `STANCATTI-REGISTRY.json`.

O `payload.sha256` não é o hash do ZIP: é SHA-256 de cada entrada de payload ordenada como `path + NUL + uint64-be tamanho + bytes`. O SHA-256 do ZIP completo está em `packaging.artifactSha256`, no sidecar `.sha256` e na Release. Essa separação evita a autorreferência impossível de um ZIP que contenha o próprio SHA.

Limites default:

| Limite | Valor |
|---|---:|
| ZIP | 50 MiB |
| expandido | 200 MiB |
| arquivo individual | 20 MiB |
| arquivos | 10.000 |
| caminho | 240 caracteres |

`redistribution: allowed` exige todos os `noticePaths` no pacote. `link-only` nunca gera ZIP e mantém o link oficial. Licenças MIT dos seeds permitem redistribuição do código com avisos, mas não de marcas ou serviços hospedados.

## Seeds oficiais

`seed/initial-projects.json` contém políticas, não pins:

- `mattpocock/skills`: `promoted`, sem experimental; skills promovidas são o padrão e o aviso contra instalar plugin e Skills CLI juntos é preservado.
- `upstash/context7`: `stable`, streams independentes; MCP, CLI/skills e plugins são Resources distintos; corpus/backend hospedado não é copiado.
- `obra/superpowers`: `stable`, sem experimental; variantes Claude, Cursor, Codex, Gemini, pi e genérica permanecem separadas.

`npm run seed:resolve` consulta a API oficial no momento da execução e escreve apenas `.generated/seed/*.json`. A aprovação inicial atual está representada nos manifestos com releases estáveis observadas e hashes de caminho; novas versões entram por detecção/revisão/PR.

## Workflows

### Validação

`validate.yml` usa permissões `contents: read`, `npm ci --ignore-scripts`, build, testes, validação, regeneração do índice e `package:dry-run` local. Pull Requests nunca recebem token de publicação.

### Sync diário/manual

`daily-sync.yml` roda por schedule e `workflow_dispatch`. Gera chave UTC `daily-YYYY-MM-DD`, chama `POST /api/admin/registry/sync-runs` com `scope: all`, `trigger: scheduled|manual` e `idempotencyKey`. O backend consulta upstream, registra candidatos e expõe a preparação de PR; nenhum conteúdo externo é executado e nenhuma PR é mesclada pelo workflow.

### Publish/reconcile

`publish.yml` roda em push de `main` somente quando a variável explícita `ENABLE_REGISTRY_PUBLISH=true` está habilitada. Por padrão, o gate permanece desligado para que a criação/push inicial não publique releases. Quando habilitado após revisão operacional, valida novamente, reconstrói exatamente os ZIPs aprovados com `--live`, cria/atualiza tags de Release `resource/{slug}/{version}` e envia `.sha256`. Por fim chama `POST /api/admin/registry/reconcile` com o commit de `main`. Falhas de callback não apagam assets; a reconciliação pode ser repetida.
