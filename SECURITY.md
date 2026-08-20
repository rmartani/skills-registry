# Security Policy

## Reporte

Não abra uma issue pública para vulnerabilidades que possam expor tokens, executar conteúdo externo, publicar um manifesto sem revisão ou servir um archive inseguro. Envie um relatório privado ao mantenedor do repositório.

## Fronteiras

Este repositório é um catálogo e empacotador de dados. Nenhum arquivo baixado de upstream pode ser executado durante:

- resolução de seeds;
- detecção de releases/tags e hashes;
- validação de JSON/ZIP;
- geração de pacote;
- workflow de Pull Request ou publicação.

O CI usa `npm ci --ignore-scripts`. Actions de checkout/setup-node são pinadas por SHA completo. Workflows que publicam releases só rodam em `main` e não aceitam código de Pull Request para obter credenciais.

## Validação de archives

O packager rejeita caminhos absolutos, `..`, NUL, symlinks dentro do payload selecionado, devices/tipos especiais, duplicatas e limites excedidos (50 MiB ZIP, 200 MiB expandido, 20 MiB por arquivo, 10.000 arquivos e 240 caracteres por caminho). Symlinks fora do `monitoredPath` podem ser lidos apenas para validação de headers e nunca são copiados. A licença/notice declarada é obrigatória quando a redistribuição é permitida. O estado transitório `packaging.mode: staged` só aceita licença redistribuível, não contém checksum/asset e é rejeitado pela validação canônica antes de reconcile; o handoff pós-merge só o troca por `registry-zip` após reconstrução e verificação. O `STANCATTI-REGISTRY.json` registra origem, ref, commit, caminho monitorado, licença e hash do payload.

## Segredos e publicação

- `STANCATTI_API_KEY` é usado somente server-to-server e nunca aparece em logs ou DTOs.
- O callback de reconcile recebe apenas o SHA do commit; URLs de download são derivadas dos manifestos/release, nunca de input público.
- O workflow diário detecta por meio da API, não executa upstream e não mescla PRs.
- A aprovação humana e os checks de branch protection permanecem obrigatórios.
- `packaging.mode: staged` só passa na CI em uma PR backend-gerada `registry/publication/*` quando `ENABLE_REGISTRY_PUBLISH=true`; com o gate desligado, a mensagem orienta habilitar a variável ou converter para `registry-zip`, e main/reconcile rejeitam o estado transitório.
- O workflow de handoff comita somente manifestos de versão gerados e `registry/index.json` em `registry/publication/*`; considera arquivos rastreados e não rastreados na allowlist, não force-pusha nem mescla PRs e falha fechado antes de release/reconcile se permanecer `staged`, se houver alteração fora dela ou se SHA/tamanho do artefato divergirem. Releases e reconcile só ocorrem em `main` canônico após merge humano.
