# Interface integrada — grafite e azul discreto

Em 21/10, o usuário aprovou **azul discreto** para a direção com navegação integrada. O frontend agora a usa por padrão, sem parâmetro de URL ou variável de ambiente. A interface está no build de desenvolvimento; não foi publicada nem copiada para a instalação.

## Implementação

- Navegação integrada com marca plana, seletor completo de servidores, atalhos recentes e acesso a criação/convites. A tela inicial usa os servidores reais, contexto da chamada e perfil/configurações, sem métricas inventadas.
- Chamada e conversa na mesma coluna, com alternância do chat e controles visíveis. Capacidades do núcleo e contratos de ações continuam existentes.
- `StatePanel` para carregamento, ausência de canal e ações pertinentes; falhas de voz persistem com reconexão explícita.
- `desktop/web/src/styles/workspace.css` consolida superfícies, tipografia, foco, controles e estados compartilhados de login, configurações, perfis, menus e modais. Aurora foi retirada do bundle.
- Botões sólidos preservam `class`, `className`, `type`, `form` e `disabled`. Ações usam `type=button` por padrão. Marca sem gradiente e cards sem iluminação/rastreamento do mouse. Personalização de arte/cores do perfil permanece.
- Botões nativos para membros e seleção de canal, ações de canal separadas, tooltips por foco/hover com `aria-describedby` e Escape. Movimento reduzido também remove espera no fechamento dos overlays. O aviso de tela cheia expira por temporizador mesmo com animações desativadas.

Paleta: canvas `#1E2021`, painel `#292C2D`, azul `#A4B8E6`, seleção `#303B51`, botão `#405780` e texto do botão `#F3F6FF`. Contrastes calculados para pares específicos: texto/botão 6,72:1, texto/hover 5,51:1, texto/seleção 8,93:1. Não representam auditoria de todas as telas.

A chave `TRISCORD_DESIGN_PREVIEW` foi retirada do núcleo, pois a direção aprovada é o padrão. O identificador e os dados separados `app.triscord.rust-preview` permanecem. Sem bridge nativa, a página continua usando os fixtures existentes; isso não representa conta/chamada real.

## Verificação

TypeScript, unidades Node de estado de voz/IPC/VNodes, build Tailwind/esbuild, 104 testes Rust sem interface e compilação Windows MSVC passaram. O build continua sequencial com `-j 2`. A análise estática da folha confirma a contenção dos seletores em `data-design=workspace`; não comprova geometria ou aparência em execução.

O aviso não fatal `corrupt .drectve` continua no build script do host. `runtimeVerified=false`: nenhum aplicativo, navegador, instalador, captura, dispositivo ou E2E foi executado. O aplicativo instalado e chamadas não foram interrompidos. Não houve push, release ou deploy.

## Limites restantes

A direção visual foi aprovada e aplicada ao código. Ainda falta conferir a aparência e interação das telas reais quando a validação visual for permitida, incluindo larguras menores, popouts, vídeo nativo, menus sobre vídeo, foco e estados de formulário. As imagens SVG/PNG anteriores são propostas estáticas; a revisão 02 registra a alternativa cobre, substituída pela escolha de azul. Não afirmar paridade funcional completa ou resolução dos problemas de mídia da reescrita por esta mudança visual.

## Continuação — orientação e envio de mensagens

O tipo do canal agora vem exclusivamente do campo `kind` do snapshot; nomes como “Geral” deixam de converter visualmente um canal de voz em canal de texto. A conversa permanece disponível antes de entrar na voz, junto a um painel compacto de participantes e entrada explícita. O botão da lista de membros anuncia seu estado expandido.

O compositor ganhou ação de envio visível, aviso de envio em andamento e erro acessível com nova tentativa. Um pedido pendente bloqueia submits duplicados. Em falha do comando IPC, o rascunho permanece; uma resposta de sucesso não limpa texto editado durante o pedido. Trocas de servidor/canal remontam o painel por identidade, descartando feedback de outra sala. O temporizador de limite de mensagens é cancelado no unmount. A aceitação do comando pelo núcleo não é comprovante de entrega ao servidor; o protocolo atual não oferece confirmação individual de entrega.

TypeScript, unidades Node existentes, 104 unidades Rust, build frontend e compilação MSVC passaram após essa continuação. Não foram exercitados envio real, teclado, layout ou dispositivos. runtimeVerified=false. Conferência visual permanece pendente.

## Continuação — dispositivos e controles acessíveis

A barra de chamada agora inclui desativar/reativar áudio e opções de saída, também quando a lateral está oculta pela tela cheia ou no popout. O início usa o tom real do estado de voz, sem ícone sempre positivo em erro/reconexão.

`DeviceSelect` substitui o listbox manual nas configurações: seleção nativa por teclado e busca por nome, escolha explícita de padrão do Windows, IDs únicos e identificação de dispositivo desconectado sem fallback silencioso. Unidades Node sem DOM cobrem os IDs duplicados, dispositivo ausente, seleção padrão e ausência de callbacks ao reescolher o mesmo dispositivo. Nenhum dispositivo é enumerado ou aberto pelo teste.

Configurações receberam margens de leitura, uma coluna para campos em larguras menores e navegação superior em janelas estreitas. A busca sem resultados mostra orientação. A seleção da página usa `aria-current=page`; uploads de imagem do perfil mostram foco no rótulo visível. Essas regras foram analisadas e compiladas, não renderizadas para comprovar seu layout.

TypeScript, unidades Node, 104 unidades Rust e compilação MSVC passaram. runtimeVerified=false; sem E2E, app, instalador, captura ou dispositivos. Objetivo ainda em andamento, inclusive auditoria de preservação dos temas configuráveis e conferência visual completa quando permitida.

## Continuação — preferências de aparência

A paleta fixa da primeira aplicação do workspace anulava parte dos temas existentes. `workspace-themes.css` agora adapta Claro, Cinza, Escuro, Ônix e Algodão-doce aos mesmos componentes; Escuro mantém a direção grafite/azul aprovada. Algodão-doce usa superfícies claras suaves e destaque malva, sem camadas animadas ou gradiente de fundo. Os controles continuam gravando as mesmas chaves existentes.

Cores de seleção, hover, mensagens, alertas e botões passam por tokens semânticos, incluindo aliases consumidos pelos componentes antigos. Os testes estáticos leem as duas folhas reais, resolvem aliases e verificam ausência de ciclos nos tokens utilizados, canvas distinto nas cinco preferências e contraste de pelo menos 4,5:1 nos pares de texto especificados (incluindo texto secundário, seleção, ações e erro). Isso não é uma auditoria de todos os elementos renderizados.

## Continuação — foco dos modais e falha de carregamento

`ModalLayer` passa a manter Tab/Shift+Tab no modal superior, focar um controle inicial quando necessário, permitir fallback sem controles e restaurar o elemento de origem quando ele ainda existe. Controles ocultos/desativados são excluídos e grupos de rádio mantêm um único ponto de Tab. A suspensão do vídeo nativo fica vinculada ao ciclo de montagem, sem alternar a cada atualização do callback. Modais recebem `aria-modal=true`; Escape ainda deixa o menu interno do seletor de transmissão fechar primeiro.

A política de escolha do próximo foco é testada com listas de objetos, sem DOM: bordas, interior, foco externo, lista vazia e um único controle. Filtragem dos elementos reais, restauração, múltiplos modais, menus e interação de teclado não foram executados; esses testes unitários não comprovam a integração visual.

O perfil oferece “Tentar carregar novamente” quando a consulta falha. O formulário anuncia carregamento/ocupação e as respostas de tentativas antigas continuam descartadas pelo ciclo do efeito. TypeScript, unidades Node, 104 unidades Rust e compilação MSVC passaram; runtimeVerified=false.

## Revisão visual autorizada e anotações do usuário

Em 21/10, o usuário liberou revisão visual isolada e depois E2E e áudio nesta tarefa. A interface compilada foi servida somente em localhost com `FixtureBridge`, sem sessão real, núcleo nativo ou dispositivos. A revisão revelou e corrigiu fundos de card indevidos nas mensagens e identificação de participantes oculta por inatividade na chamada integrada.

Aplicadas as cinco anotações: removidos o bloco de marca e o rótulo “Seu espaço” no topo; seletor permanece acessível com o nome “Servidor”, e “Início” mantém seu comando. Contagens de membros não usam traços. A seleção de canal usa só o fundo, sem faixa lateral. Configurações passam a usar títulos de 18 px, rótulos de 14 px e descrições de 13 px.

Na página real do navegador, observados o ciclo Shift+Tab do primeiro controle para o último e Tab de volta ao primeiro; fechar configurações restaurou foco ao botão de origem. Evidências ignoradas pelo Git em `desktop/out/design-review/`: `settings-compact.png`, `call-simplified.png` e `call-logo-gray.png`. São renders do frontend com dados de demonstração, não screenshots de uma chamada real nem prova de mídia nativa. A largura/tamanho da prévia foi ajustada temporariamente para avaliar a composição; nenhuma preferência real do usuário foi alterada.

Após as mudanças, TypeScript, unidades Node, 104 unidades Rust e compilação MSVC passaram. `nativeRuntimeVerified=false`: o executável/instalador não foi aberto, nenhum E2E contra Workers/contas reais ou áudio foi executado nesta etapa. Restam as demais telas/estados e integração com janelas de vídeo nativas; a autorização nova remove o bloqueio anterior de validação.

## Padrão cinza da logo

O usuário definiu que o tema padrão deve ser cinza como a logo. A cor opaca predominante de `desktop/assets/triscord-app.png` é RGB (40, 43, 48), `#282B30`; ela foi usada como canvas da variante Cinza (`dark`). Primeiro paint do frontend e preferências novas do núcleo Rust agora usam `dark`. Preferências explícitas já salvas não são substituídas. Azul discreto continua somente como destaque dos controles/seleção. Contrastes especificados continuam passando para as cinco variantes. O navegador confirmou `data-theme=dark`, canvas `#282b30`, ausência de marca/rótulo no topo e `box-shadow=none` no canal selecionado. Configuração de transmissão continua limitada a 60 FPS no codificador; não se confunde com FPS da interface, ainda não medido no executável nativo.

## Revisão das telas completas e início nativo

O executável debug Rust/WebView2 foi aberto com `TRISCORD_TEST_DATA_DIR` absoluto exclusivo e inspecionado na tela de entrada, com a logo real e a paleta cinza. Ele foi fechado; nenhuma sessão instalada, conta, chamada ou dispositivo foi usado. Evidência local `native-login.png`. `nativeStartupVerified=true`; isso não valida login completo ou mídia nativa (`nativeMediaVerified=false`). O `runtimeVerified=false` do build script descreve apenas sua própria execução sem abrir o app.

A marca triangular antiga foi substituída pelo glyph existente da logo. O início agora usa termos de servidor, uma instrução direta e acesso a perfil/configurações pela lateral, sem frases/ações repetidas. Membros são agrupados pela identidade de conta, incluindo a conexão própria, evitando exibir a mesma pessoa por conta e por socket. O teste de regressão cobre a conta própria com outro ID de socket e dois sockets da mesma conta remota.

Em 850×600 foram reproduzidas duas falhas do perfil: a primeira linha da grade encolhia e a prévia invadia os campos abaixo; o foco também podia rolar o contêiner externo oculto e deslocar o rodapé. Agora linhas usam tamanho de conteúdo, o contêiner externo corta sem ser rolável (`overflow:clip`) e o rodapé não encolhe. Após preencher e salvar pela bridge local, medidos `overlap=0`, `outerScroll=0`, formulário começando em y=49 e rodapé terminando em y=551 dentro do modal até y=552. `profile-minimum-saved.png` e `profile-reviewed.png` registram os renders. Observado feedback “Perfil salvo.” apenas na simulação local.

Fixtures explícitos de início, vazio, erro/reconexão de voz e falha de perfil permitem revisar estados sem rede. A bridge de demonstração responde a carregar/salvar perfil localmente; a bridge nativa continua sem fallback para fixtures. Foram conferidos o erro de perfil com nova tentativa, o estado sem servidores e a transição ao modal de criar/entrar. Textos do modal não prometem upload de ícone inexistente nem oferecem um código de convite fictício clicável; convite vazio não pode ser enviado.

TypeScript, unidades Node (incluindo identidade/fixtures), 104 unidades Rust e compilação MSVC passaram em `complete-form-review-build.log`. Não houve E2E de backend, áudio real, instalador, push, release ou deploy. Ainda faltam a revisão de vídeo/popout/menus sobre superfícies nativas e a cobertura completa dos demais estados; não declarar o objetivo integral concluído.

## Revisão de chamada, foco de vídeo e ações de participantes

A revisão da interface de chamada e das superfícies de vídeo revelou e corrigiu o estado da visão ampliada (*stage focus*):
- No `ChannelView`, a seleção de foco dependia exclusivamente de `session.callFocus` do snapshot. O núcleo Tauri/Rust não mantinha essa propriedade, impedindo a expansão dos cards de transmissão/câmera para o palco de destaque. Foi introduzida a sincronização de `localFocus` com despacho imediato de `setCallFocus` via bridge.
- O modelo Rust (`Model`) agora possui o campo opcional `call_focus: Option<Value>`, serializado no snapshot como `callFocus`. O comando `setCallFocus` atualiza o modelo e dispara publicação de snapshot para a interface. O foco é limpo em `reset_connection`, ao sair da sala e ao ser expulso (`kicked`).
- No seletor de compartilhamento (`SharePicker`), a aba "Dispositivos" é omitida quando a runtime não suporta câmera ou quando nenhum dispositivo de captura está presente, evitando tentativas inválidas de `startDeviceShare`.
- No menu de contexto do participante (`ParticipantMenu`), foi adicionado o item funcional "Silenciar para mim" (`setPeerAudio` com `muted`), suportado pela tabela `peer_muted` do núcleo Rust. Os controles deslizantes de volume individual ("Volume do usuário" e "Volume da transmissão") e "Silenciar transmissão" continuam omitidos sob a runtime Tauri, evitando erros de operação indisponível antes da implementação de mixagem DSP dedicada.
- O `FixtureBridge` passou a refletir `setCallFocus`, `setCallFullscreen` e `setStreamHidden`. O fixture `stream-focus` permite testar a visão ampliada estaticamente. Testes de contrato cobrem a emissão desses comandos e as ações filtradas por runtime.

