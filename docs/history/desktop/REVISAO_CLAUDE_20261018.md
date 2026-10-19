# Revisão da continuação do Claude Code — 18/10/2026

**Atualização:** os quatro problemas abaixo foram corrigidos na versão 0.9.23, a pedido do usuário. O restante do documento preserva os achados originais.

- Atualizador: `setTransferTimeout(10000)` em cada requisição, cobrindo consulta, checksum e instalador. Teste com checksum parado e instalador interrompido confirmou falha recuperável, nova tentativa e remoção do arquivo parcial.
- Portátil: o lançador informa seu runtime ao atualizador; após instalação bem-sucedida, `/PORTABLE` publica um arquivo com o caminho instalado. Nas próximas aberturas, o lançador usa esse caminho; se o executável não existir mais, usa o runtime original. O caminho é transmitido pelo ambiente para preservar espaços. Testes com NSIS real verificaram duas aberturas sucessivas; o Qt real também foi testado no download/hash/repasse de `/PORTABLE` com um instalador inofensivo.
- Chamada: identidade e permissões usam a lista completa; o filtro aplica-se somente aos cartões e à faixa de miniaturas. Menus por clique direito e eventos do vídeo nativo foram verificados com participantes sem câmera ocultos.
- Submenus: direita/Enter abrem e transferem foco; esquerda/Escape retornam ao pai; seleção por teclado e mouse aciona apenas a opção escolhida. Itens desabilitados são ignorados.

Regressões reproduzíveis: `tests/ui_review_regressions.mjs`, `tests/portable_update_regression.py --updater-exe out/release/triscord-web.exe` e `tests/e2e/run_web_updater_e2e.py`. Checagem de tipos e 12 testes nativos passaram nesta correção. Os testes de instalador usam diretórios temporários e uma chave exclusiva de teste; não substituem a instalação do usuário.

Entrega: `C:/Users/camargo/Desktop/Triscord.exe`, versão **0.9.23**, SHA-256 `A5ABD92DA3FAA1C16B340F60ADBD161CB351B717BB7D65A2DB4933CA2529A5B5`. Pacote e portátil passaram nas 44 verificações; o teste de chamada com dois clientes reais, mídia sintética e backend local passou nas 29 verificações. A versão anterior da Área de Trabalho foi preservada em `out/previous-desktop-0.9.22.exe`. Sem commit, push ou publicação nesta correção.

Conversa lida: sessão `3087772c-b442-4b9f-891b-2b4b2e1b01fa` do projeto Claude `triscord-completion-239b41`. Revisão da árvore compartilhada C++/Qt + WebView2, incluindo a auditoria visual de duas rodadas. As conclusões abaixo distinguem problemas reproduzidos de caminhos analisados estaticamente.

## Problemas encontrados

### 1. [P1] Download de atualização pode impedir o aplicativo de abrir sem limite de espera

Em `desktop/src/update_splash.cpp:135`, o limite de dez segundos é armado para consultar releases e desligado na linha 137. O checksum é solicitado na linha 178 e o instalador na linha 191 sem rearmar o timer ou definir `transferTimeout`. A janela principal só é construída depois que o atualizador libera o ciclo de espera (`desktop/tools/web_main.cpp:115`).

**Reproduzido:** servidor local respondeu à lista de releases e manteve a conexão do checksum aberta. Depois de doze segundos nessa etapa, o aplicativo continuava na splash com “Downloading update 1 of 1… 0%”, sem erro, nova tentativa ou janela principal. O processo de teste tinha perfil isolado, não instalou nada e foi encerrado pelo seu próprio identificador.

Correção recomendada: limite de inatividade para cada etapa de rede, incluindo checksum e binário; timeout deve abortar a resposta correta e sair do estado de download de maneira recuperável.

### 2. [P1] O portátil inicia um instalador, mas seu lançador antigo permanece inalterado

`desktop/packaging/portable.nsi:34` vincula o lançador a um diretório de runtime fixo por `PACKAGE_ID`; a linha 69 sempre abre esse executável. O atualizador executa o instalador com `/S /UPDATE` (`desktop/src/update_splash.cpp:215`). O instalador usa `%LOCALAPPDATA%\Triscord\app` e, com `/UPDATE`, não cria atalhos (`desktop/packaging/installer.nsi:103`).

**Análise estática:** ao atualizar a partir do portátil, a versão nova é instalada e aberta em outro caminho, mas o `Triscord.exe` portátil da Área de Trabalho continua apontando para o runtime antigo. Na próxima abertura pelo mesmo arquivo, volta a consultar a versão antiga e pode baixar/reinstalar a mesma atualização. Não executei um instalador real para reproduzir este caso.

Correção recomendada: definir explicitamente o fluxo do portátil — atualização do lançador ou redirecionamento persistente para a instalação atual — e testar duas aberturas consecutivas após uma atualização.

### 3. [P2] Ocultar participantes sem câmera remove o dono da transmissão da busca dos menus

Em `desktop/web/src/components/CallView.tsx:228`, `users` já recebe o filtro de participantes sem câmera. Essa mesma lista é usada por `menuFor` na linha 237 e pela busca do dono dos cartões. Uma pessoa transmitindo tela sem câmera é removida de `users`, embora sua transmissão continue visível.

**Reproduzido em componente real no Edge sem interface:** mesma transmissão de Alice, sem câmera. Com o filtro desligando participantes sem vídeo: um cartão, zero menus ao clicar com botão direito. Reativando participantes: o mesmo cartão e um menu. Perfil, áudio, ocultar transmissão e moderação ficam inacessíveis por esse cartão no primeiro caso.

Correção recomendada: manter a lista completa para resolver identidade/permissões; aplicar o filtro somente à composição visual dos cartões de participantes.

### 4. [P2] Os submenus novos não podem ser abertos pelo teclado

`desktop/web/src/components/ContextMenu.tsx:45` trata setas para cima/baixo e Enter/Espaço. Enter executa `action`, mas não muda `open` quando há submenu. A única abertura fica em `onMouseEnter`, linha 78. O submenu filho também é criado sem a propriedade `focus` na linha 93.

**Reproduzido no componente real em Edge sem interface:** selecionar “Câmera”, pressionar seta para a direita e Enter deixou zero itens do submenu; passar o mouse abriu o item normalmente.

Correção recomendada: implementar seta para direita/Enter para abrir e transferir foco; esquerda/Escape para retornar ao menu pai, preservando a navegação dos itens.

## O que o Claude entregou

- Concluiu a integração da rodada de fidelidade iniciada pelo Codex, incluindo os recursos originais de áudio e os ajustes de transmissão, fontes, perfil e Markdown.
- Acrescentou transmissão por dispositivo, operações de sair/excluir servidor e navegação entre servidores preservando a chamada.
- Criou ícone, instalador e splash/checagem de atualização; adicionou tema rosa e removeu o servidor fixo conforme pedido.
- Fez duas rodadas adicionais de auditoria visual: dropdown do servidor, menus, cartão de conta, controles da chamada, áudio, boas-vindas do chat e outros ajustes registrados em `AUDITORIA_VISUAL_20261018.md`.
- Registrou a publicação autorizada do Worker do hub. Esta revisão não executou publicação nem instalação.

## Verificação e limites

- `npm run typecheck` passou nesta revisão.
- Os relatórios atuais de distribuição registram 21 verificações aprovadas da release e 23 do portátil. O SHA-256 do `Triscord.exe` da Área de Trabalho coincide com o manifesto atual, versão 0.9.22: `76117E4E87D1CAE618110391B1BE73B8F80BA629606098C40404E981DBC6F13A`.
- O teste existente do atualizador usa uma cópia de `whoami.exe` como instalador simulado: comprova download/hash e início de outro processo, mas não comprova uma instalação real, reinício da versão nova ou atualização persistente do portátil.
- Os testes reportados pelo Claude não foram todos repetidos nesta revisão. Os três cenários novos de reprodução têm seus resultados em `out/claude-review-20261018/` (`stalled-checksum-result.json`, `call-filter-result.json`, `menu-result.json`).
- A interface continua com diferenças declaradas: anexos/emoji/apps no composer, prévia da câmera, partes dos menus, medidor de microfone e modelos de servidor, entre outras. Testes aprovados não significam que a interface inteira está idêntica ao Discord.
- Código de produção e pacote da Área de Trabalho não foram alterados nesta revisão.
