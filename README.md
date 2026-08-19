# Stancatti Skills Registry

Repositório público canônico de manifestos aprovados, proveniência e pacotes determinísticos do **Skills Registry**. Ele contém somente contratos e dados aprovados; não executa conteúdo de nenhum upstream.

## Escopo e segurança

- Domínio: **Project → Collection → Resource**.
- Tipos: `skill`, `skill-pack`, `mcp-server`, `plugin` e `prompt-pack`.
- Somente versões aprovadas entram em `registry/`; candidatos continuam no backend até uma Pull Request aprovada e mesclada.
- O workflow diário/manual chama a API autenticada para detectar atualizações. A abertura de PR é uma operação auditável do fluxo de publicação; nenhum workflow mescla ou publica uma proposta automaticamente.
- Releases estáveis têm precedência. Conteúdo experimental, deprecated, `in-progress` e prerelease é ignorado salvo opt-in explícito.
- Importação, validação e empacotamento tratam o upstream como dados não confiáveis: não usam shell, `npm install`, hooks, classloaders ou scripts do conteúdo baixado.
- O catálogo inicial usa os projetos oficiais `mattpocock/skills`, `upstash/context7` e `obra/superpowers`. Context7 mantém MCP, CLI/skills e plugins em fluxos de versão independentes; corpus/API hospedados não são copiados.

## Layout

```text
registry/
├── index.json                 # gerado; SHA de todos os manifestos canônicos
├── redirects.json             # redirects de slug explícitos
└── projects/{project}/
    ├── project.json
    ├── collections/{collection}.json
    └── resources/{resource}/
        ├── resource.json
        └── versions/{version-id}.json
schemas/                       # JSON Schema draft 2020-12
examples/                      # uma fixture por schema
seed/initial-projects.json     # políticas, sem versões fixadas
src/                           # validator, index, detector e packager
```

Consulte [`docs/CONTRACTS.md`](docs/CONTRACTS.md) para o contrato executável.

## Desenvolvimento

Requer Node.js 22+:

```bash
npm ci --ignore-scripts
npm run build
npm test
npm run validate
npm run index
npm run package:dry-run
npm run package:prepare -- --output .generated/packages
```

`npm run index` é determinístico. O CI exige que o índice gerado não produza diff no estado canônico. `npm run package:dry-run -- --live` baixa apenas archives oficiais para reconstruir assets em `.generated/packages/`; valida caminhos, limites e notices antes do inflate e nunca executa arquivos upstream. `npm run package:prepare` é reservado ao handoff pós-merge: converte somente versões `packaging.mode: staged` para `registry-zip` depois de gerar e conferir o pacote, atualizando apenas o manifesto da versão e o índice. O SHA do ZIP é distinto do `payload.sha256` dentro de `STANCATTI-REGISTRY.json`, pois um ZIP não pode conter seu próprio SHA sem autorreferência.

Para resolver os seeds atuais sem alterar manifestos aprovados:

```bash
npm run seed:resolve
```

A saída fica somente em `.generated/seed/` (ignorada pelo Git) e contém releases estáveis observadas no momento da execução. Nenhuma versão do research/spec é usada como mecanismo de atualização automática.

## Workflows

- `validate.yml`: valida schemas/referências, testes, regenera o índice e faz dry-run/live seguro; somente PRs backend-geradas em `registry/publication/*` com `ENABLE_REGISTRY_PUBLISH=true` podem carregar `staged` (o handoff pós-merge é transitório), sem receber token ou release. Com o gate desligado, a CI falha com instrução para habilitá-lo ou converter para `registry-zip`.
- `daily-sync.yml`: schedule diário e `workflow_dispatch`; `scope: all` mantém `resourceIds: []`, enquanto `scope: resources` exige `resource_ids` com UUIDs canônicos separados por vírgula; envia `scope`, `resourceIds`, `trigger` e uma chave idempotente para `POST /api/admin/registry/sync-runs` com `X-API-Key`.
- `publish.yml`: somente em `main` e com `ENABLE_REGISTRY_PUBLISH=true`, converte `staged` pós-merge, comita apenas metadata/index gerados, reconstrói e verifica pacotes determinísticos, cria/atualiza Releases com `GITHUB_TOKEN` e solicita reconciliação pelo commit final. O gate permanece desligado no repositório inicial.

Secrets usados pelo workflow diário/publicação:

- `STANCATTI_API_URL`
- `STANCATTI_API_KEY`

O token nunca é impresso. O `GITHUB_TOKEN` do publish tem apenas `contents: write`; a validação de PR possui `contents: read`. Configure branch protection exigindo o check `validate` antes de merge. Não habilite o gate de publish sem configurar e revisar os secrets server-side.

## Licenças upstream

Os três seeds observados são MIT. O pacote mantém os arquivos `LICENSE` declarados no manifesto. MIT permite redistribuição do código com copyright e licença, mas não concede marcas nem o serviço hospedado da Context7. Recursos com `packaging.mode: link-only` permanecem apontados para a origem oficial.
