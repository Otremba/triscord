# Auditoria de fidelidade fora da transmissão e do áudio — 18/10/2026

Escopo: interface Preact/WebView2 atual, comparada com evidência Discord já retida. Esta passagem não abriu o Discord, não entrou em chamada e não fez capturas novas de contas reais. Não mede paridade integral nem substitui a revisão de transmissão, overlays nativos e sons conduzida separadamente.

## Origem da evidência

- REA já retido: `out/rea-claude-20261016/guild-analysis.json`, `ev_f85e89975ce532921d5aab85eb0beca9111ca06655958f345278e4a442d4e977`, alvo `85cf55153548d9f0a9017ac5832f400c3632b579ce6065325b89dd8f827d33ed`. É análise estática; não prova execução/visualização de todas as telas.
- Regras CSS recuperadas e retidas em `out/rea-claude-20261016/css-rules/`. Composer: `textArea_.css.txt` e `scrollableContainer_.css.txt`, bundle `962953.69892aacbc3b8e17.css`, SHA-256 `3f890ec1374125d2c555483b78ef385fafe1c531cdf83b39672decddc547ca74`.
- Comportamento multiline: evidência REA `ev_d059b269e2eaab4b92a4d2138c64d92c0a26eb247ae0992b6e2cdbe5b7927eeb`, módulo 479909, catalogada em `out/discord-reference-spec.md` (allowNewLines, limite 50vh). O documento antigo descreve também Widgets; sua coluna de implementação não foi tomada como prova do WebView2 atual.
- Observações anteriores de runtime: `out/claude-observations/{CHAT,SETTINGS,SIDEBAR,CONTA_POPOVER,PERFIL,ESTADOS_NAO_OBSERVADOS}.md`, com capturas e método registrados. Revisão visual da captura já retida `discord-account-popover.png`; nenhum conteúdo de terceiros foi copiado para este relatório.
- Inspeção comum do código atual em `web/src/components` e `web/src/styles`: serve para confirmar a implementação do Triscord, não é uma nova chamada REA.

## Correção aplicada e verificada

O chat de voz usava `<input>` de uma linha, apesar de o composer recuperado aceitar múltiplas linhas e crescer. `ChatPanel.tsx` agora usa textarea: Enter envia; Shift+Enter cria linha; Enter durante composição IME não envia; texto cresce a partir de 56 px até 50vh e passa a rolar internamente. O rascunho volta à altura inicial depois do envio. Permanecem os limites reais do backend e o tratamento de erros existente.

`web/src/styles/chat.css` mantém a linha de 22 px e padding vertical `(56px - 22px)/2`, com fonte herdada e sem alça de redimensionamento. A caixa externa acompanha a altura do campo. Nenhum controle de anexo, presente ou envio fictício foi adicionado.

Validação: `npm run typecheck` passou. `node tools/check-chat-composer.mjs` passou em **7 verificações** no Edge headless, executando o componente real sem rede, usuário ou áudio. Resultado em `out/web-chat-composer/report.json`: altura inicial 56 px; Shift+Enter sem envio; composição IME; envio único preservando quebra de linha e reset; rascunho longo limitado a 400 px numa janela de 800 px; limite acompanha janela de 600 px (300 px); branco não envia. Isso verifica comportamento/geometria do componente, não identidade de rasterização Discord/WebView2/Qt.

Também foram corrigidos o popover de conta e o editor de perfil:

- Popover com largura300, banner104 e avatar88 sobreposto, nome abaixo e chamada de status ao lado do avatar. O formulário de status aparece ao clicar nessa chamada e preserva salvar/limpar; sair continua pedindo confirmação. A posição horizontal agora considera a largura real do cartão. O avatar usa a mídia original do perfil quando disponível.
- Editor com shell1168, lateral240, cartão400 e intervalos32, cabeçalho49 restrito à lateral, fechar32 no canto e banner400×140/avatar120+anel8. A coluna direita contém os campos reais do Triscord; isso é **adaptação funcional explícita**, pois o mural/widgets Discord não tem backend equivalente. Não foram inventados widgets, compras ou ações. Salvar e descartar continuam usando o formulário existente. Em janelas estreitas as colunas se reorganizam sem ultrapassar o viewport.
- `node tools/check-profile-layout.mjs`: **6 verificações passaram**, incluindo as medidas, envio dos campos ao backend simulado, responsividade e edição do status. Capturas próprias revisadas em `out/web-profile-layout/{profile-desktop,account}.png`; relatório em `report.json`. O driver existente `tests/e2e/run_web_account_e2e.py` foi atualizado para abrir o editor de status pelo novo botão; não foi executado nesta passagem, para evitar concorrência com os testes nativos da revisão principal.

## Matriz de cobertura e diferenças confirmadas

| Superfície | Constatação atual | Estado desta passagem |
|---|---|---|
| Trilho de servidores/lateral | `--tri-sidebar-width:375px` registra referência observada 72+303; o token estático Discord 268 px não é a largura personalizada observada. | Não substituir 303 por 268 arbitrariamente; sem nova comparação pixel a pixel. |
| Painel de conta | Rótulos reais de status e username no hover já existem em `AccountPanel.tsx`; alegação antiga de `@online` em `LAYOUT_COMPARISON.md` está desatualizada para este componente. | Nenhuma mudança especulativa. |
| Popover da conta | Antes340/banner80/avatar56 horizontal; agora300/banner104/avatar88 sobreposto, nome abaixo e chamada de status. | **Geometria e estado de edição corrigidos**; Orbs/troca de contas são recursos ausentes, não margens erradas. |
| Chat de voz | Painel 450 px; avatar40, conteúdo a72, texto16/22, ações28/altura32, divisor data12 já correspondem à evidência retida. Composer era uma linha. | Composer corrigido; demais medidas confirmadas no CSS, sem alegação de paridade renderizada integral. |
| Conteúdo das mensagens | `message.text` é renderizado como texto simples; avatar é inicial do nome. Parser Markdown existe no cliente Widgets, mas não está ligado a este componente Web. | **Lacuna funcional confirmada**: links, spoilers, markdown e avatar real não são fechados pela presente correção. Exige contrato/renderizador seguro; não usar HTML sem sanitização. |
| Ações de mensagem | Reações, cópia e exclusão existem; editar, responder, encaminhar e tópicos não são oferecidos. | **Lacunas de recurso**; não adicionar itens sem ação real. |
| Canal de texto | `ChannelView.tsx` possui prejoin/voz e espaço vazio fora de canal selecionado; o chat disponível fica condicionado à chamada. | **Lacuna funcional**: não há experiência completa de canais de texto/DM Discord. |
| Menus de contexto | `menu.css` aplica medidas recuperadas: fixed220, flexible188..320, padding8, ícone20 e rótulo14/18. | Compatível na declaração; todos os itens/estados do Discord não foram observados. |
| Criar canal/convite | `modals.css`: shell480, padding24, botão40, campos40, rádio20 e tokens recuperados; funções sem equivalente não foram desenhadas. | Compatível nas partes implementadas; não representa todos os tipos/permissões de canal Discord. |
| Configurações | Shell margem40, nav251(+borda), cabeçalho49; campo/select40, texto16/20. Corresponde à medição retida. Supressão de ruído liga/desliga adapta a lista de provedores Discord. | Geometria declarada coerente; páginas e capacidades adicionais não implementadas. |
| Perfil próprio | Antes formulário+prévia em duas colunas; agora aparência à esquerda, cartão central e informações editáveis à direita, com as medidas recuperadas. | **Estrutura e medidas corrigidas**; conteúdo da direita é adaptação com campos existentes em vez de widgets inexistentes. Não representa paridade de recursos. |
| Perfil de participante | Cartão400, banner140, avatar136 com anel; captura de edição de perfil próprio não prova essa tela específica. | **Sem referência suficiente para afirmar fidelidade**; não transferir dimensões entre telas diferentes. |
| Fontes/ícones | `base.css` usa `--font-primary`; build inclui pesos gg sans locais quando presentes. Fontes nativas dos overlays e pequenas etiquetas são alvo da revisão principal. | Fonte declarada não prova arquivo carregado nem peso efetivo; ver validação principal. |
| Tema | Tokens atuais oferecem light/dark/darker/midnight; capturas antigas têm temas diferentes. | Comparar sempre mesmo tema/escala/estado; não interpretar toda mudança de cor como erro. |

## Limites e sequência necessária

A frase “tudo igual ao Discord” não é suportada por esta auditoria. Geometria do popover/editor foi corrigida, mas ainda há adaptações funcionais no perfil, recursos ausentes (Markdown web e canais de texto) e estados sem observação. A revisão principal deve entregar as correções de transmissão/tipografia/áudio pedidas e preservar esta lista ao descrever o resultado, evitando concluir que a interface inteira foi validada porque medidas CSS isoladas coincidem.

Próximas reconstruções podem reaproveitar os mesmos artefatos/capturas, mas precisam de validação própria em estado equivalente e não devem interromper a chamada real do usuário.

## Sementes concretas para o chat web

O contrato `web/src/protocol.ts:ChatMessage` contém id/authorId/authorName/text/timestamp/own/reactions e **não contém avatarUrl**. `CoreSession::publishChat` (em `src/core_session.cpp`) envia exatamente esses campos. `Account.avatarUrl` e `VoiceUser.avatarUrl` existem, mas não resolvem autores históricos/desconectados por si só. Não buscar perfis arbitrários nem atribuir avatar por nome coincidente.

O renderizador existente fica em `src/markdown_parser.{h,cpp}` e produz conteúdo para Widgets/Qt. Nenhum componente Markdown foi encontrado em `web/src` nesta busca limitada. As evidências REA de gramática e spoilers estão em `out/discord-reference-spec.md`, `discord-markdown-rea.json`, `discord-markdown-defaults-rea.json` e `discord-chat-interactions-rea.json`. Uma integração web precisa emitir AST/elementos seguros ou parser web próprio, não reutilizar HTML Qt como `innerHTML` sem validar links/atributos. Isso é etapa separada das correções de geometria desta passagem.

## Conclusão da rodada (Claude Code, 18/10/2026, madrugada)

O Codex atingiu o limite de uso no meio desta rodada, com integração, E2E e pacote pendentes. Retomei sem refazer o trabalho dele.

**Checagens do Codex, de novo no meu build:**
- Markdown 8/8, cartão de vídeo 7/7, composer 7/7 e perfil 6/6;
- fixture nativo dos selos 9/9; captura revisada: cápsula "720P 30FPS | AO VIVO" em gg sans, "🖥 nome" e "…".

**Integração:** CTest 12/12 e os 18 E2E web. Três falhas apareceram e foram resolvidas:
- **Menu sobre o vídeo:** a lista esperada não tinha "Ocultar vídeo para mim", que o Codex moveu da barra removida para o menu. Teste atualizado (5/5).
- **Visão ampliada:** o teste esperava o raio antigo de 4 px; o Codex recuperou `--custom-live-indicator-border-radius: 16px`. Teste atualizado (13/13).
- **Visão da chamada: falha real, "modal Escape" sempre.** O `ModalLayer` registrava o Esc num `useEffect`, que roda depois da pintura. Um Esc logo depois de o modal aparecer era perdido; o diagnóstico mostrou o Esc chegando e fechando quando havia espera. Agora o ouvinte fica em `useLayoutEffect` (29/29).

Depois da correção, passaram de novo os E2E com modais:
- configurações 8, opções de transmissão 15, perfil 20, áudio por participante 29;
- conta 22, chamada 10, pop-out 17.

Os demais também passaram: login 12, chat 11, moderação 35, participante 21, soundboard 18, notificações 5, menus de áudio 8 e moldura 5.

**Entrega:**
- `portable-web.ps1` (release 21 e portátil 23, 44/44 aprovados), pacote `0345fcd689b44f70df6e`;
- Área de Trabalho com SHA-256 `83E494B19CCB9D1293318BEB6997833DBFEE74169F8E5B610297DAE8B503AFA4`, hash conferido;
- backup do anterior em `out/desktop-backups/triscord-web-E2F881B2.exe`.

Se o Triscord estiver aberto, é preciso reabri-lo. As lacunas listadas acima (canais de texto, ações de mensagem, avatar no chat, perfil de participante sem referência) continuam abertas.
