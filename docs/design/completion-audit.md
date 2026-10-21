# Auditoria do objetivo de redesign

Esta auditoria mantém o escopo original. Estado em 21/10/2026: implementação em desenvolvimento, sem publicação/substituição da instalação. O usuário liberou revisão visual isolada e depois E2E/áudio. Tela principal e configurações já foram observadas no navegador com fixtures; isso não comprova as demais telas nem a integração nativa.

| Requisito | Evidência atual | Estado e limite |
| --- | --- | --- |
| Proposta concreta com navegação, canais, conversa e chamada | `main-screen.svg`, `main-screen-v2.svg` e `proposal.py` | Propostas estáticas produzidas; não são screenshots nem evidência de execução |
| Refinar antes de aplicação global | Usuário pediu mais personalidade sem glow e depois aprovou azul discreto | Direção definida; aplicada após escolha |
| Identidade própria e componentes consistentes | `WorkspaceNav`, `WorkspaceHome`, `StatePanel`, `DeviceSelect`, `workspace.css` | Código consolidado; aparência real ainda não observada |
| Tema escuro, contraste e tipografia | Tokens compartilhados, Segoe UI do sistema, teste de paletas | Pares especificados passam em contraste matemático; tipografia/layout renderizados não comprovados |
| Preservar preferências existentes | Cinco variantes em `workspace-themes.css`, mesmas chaves no core | Tokens e contratos verificados; troca real de tema não exercitada |
| Sem glow e animações permanentes decorativas | Aurora retirada do bundle, botões/marca sólidos, cards sem rastreamento; regra de movimento reduzido | Implementado por código; comportamento em execução não observado |
| Orientação por servidor/canal/voz/fala | Seletor completo, `kind` real, `callStatus`, outline de fala baseado no snapshot | Estados unitários/contratos verificados; sessão real não exercitada |
| Controles de mídia acessíveis | Barra com mute, deafen, saída, compartilhamento e desconexão; capacidades existentes | Handlers inspecionados; geometria em tela cheia/popout e menus sobre vídeo nativo não comprovadas |
| Mensagens e transmissões em destaque | Chamada e conversa na mesma coluna, controle explícito do chat, componentes de vídeo preservados | Código/build verificados; proporção, clipping e sobreposição precisam de avaliação visual |
| Carregamento/vazio/erro/reconexão | `StatePanel`, nota de conexão persistente, rascunho em falha IPC, retry de envio | Implementado; envio real e entrega individual não comprovados pelo protocolo |
| Formulários e teclado | Botões nativos, tooltips por foco, seletor nativo, foco visível, regras responsivas | Contratos sem DOM e tipos verificados; política de contenção de foco implementada/testada sem DOM; integração real e navegação completa ainda não verificadas |
| Preservar funcionalidades | Contratos IPC, capacidades, mídia de perfil, APIs e núcleo mantidos; não adicionar sucesso simulado | Preservação em código não prova paridade completa. A reescrita Rust tem limitações anteriores ao redesign |
| Acabamento das telas completas | Fontes de login, chat, chamada, perfil, configurações, menus e modais adaptadas | Sem evidência visual suficiente para declarar o objetivo concluído |

## Próximas verificações

Contenção de foco e nova tentativa de carregamento de perfil foram implementadas, com os limites registrados em `preview.md`. Quando houver autorização para validação visual, conferir telas reais nas larguras suportadas, navegação por teclado, formulários, popouts, estados de erro/reconexão e recorte de menus/vídeo. A autorização atual permite avançar nessa validação em ambiente isolado.

Os builds seguem sequenciais com `-j 2`; nesta etapa não foram executados E2E de backend, dispositivos ou instalação. Evidências e limitações por etapa estão em `preview.md`; resultados históricos não validam alterações posteriores.
