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

O CI usa `npm ci --ignore-scripts`. Workflows que publicam releases só rodam em `main` e não aceitam código de Pull Request para obter credenciais.

## Validação de archives

O packager rejeita caminhos absolutos, `..`, NUL, symlinks selecionados, devices/tipos especiais, duplicatas e limites excedidos (50 MiB ZIP, 200 MiB expandido, 20 MiB por arquivo, 10.000 arquivos e 240 caracteres por caminho). A licença/notice declarada é obrigatória quando a redistribuição é permitida. O `STANCATTI-REGISTRY.json` registra origem, ref, commit, caminho monitorado, licença e hash do payload.

## Segredos e publicação

- `STANCATTI_API_KEY` é usado somente server-to-server e nunca aparece em logs ou DTOs.
- O callback de reconcile recebe apenas o SHA do commit; URLs de download são derivadas dos manifestos/release, nunca de input público.
- O workflow diário detecta por meio da API, não executa upstream e não mescla PRs.
- A aprovação humana e os checks de branch protection permanecem obrigatórios.
