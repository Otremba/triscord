# Continuação do front web — 17/10/2026

**Atualização mais recente: sons compartilhados e avisos de chamada concluídos.** Soundboard 18/18, configurações 8/8, chamada 29/29, CTest 12/12, release 21/21 e portátil 23/23. Desktop atualizado com o cliente WebView2; detalhes e limites da validação em `SONS_20261017.md`. As notas anteriores abaixo são históricas.

Esta rodada continua o cliente WebView2/Preact já iniciado pelo Claude, mantendo núcleo C++, serviços atuais e alterações existentes. Não houve commit, deploy, migração ou substituição do pacote Qt da Área de Trabalho. Abrir o preview: `./desktop/scripts/run-web.ps1`, da raiz deste checkout.

## Entregue nesta rodada

### Perfil principal

O botão “Editar perfis” das configurações abre um editor funcional. O cartão da conta agora abre um popover próprio, com “Editar perfil” levando ao mesmo editor. Nome de exibição é distinto do nome de usuário; pronomes, bio, nota privada, cor da faixa e duas cores de tema são editáveis. O cartão acompanha o rascunho, mostra data de criação e mantém a geometria de faixa 400×140 e avatar 120 com anel 8. Salvar envia PATCH real ao Worker; Redefinir restaura os campos. Fechar com alterações pede confirmação própria do app, sem depender de dialogs JavaScript desabilitados no host. Escape fecha apenas a camada superior, preservando configurações atrás do editor.

Avatar/faixa aceitam PNG, JPEG e GIF, incluindo faixa animada. Upload e remoção são imediatos e isso é informado na tela; descartar texto não desfaz mídia já publicada. A prévia usa os bytes completos e o painel da conta recebe apenas o primeiro quadro reduzido a 128 px, evitando GIF animado ocioso fora do editor. Elementos de loja, nameplate textual, promoção Nitro, decoração sem renderer e widgets sem suporte não foram adicionados.

Evidência usada: `out/claude-observations/PERFIL.md`, `out/claude-observations/rea-css/PERFIL_BUNDLE.md` e `src/profile_preview.cpp` já derivados das observações/REA anteriores. A anotação antiga de avatar ~96 px foi superada pela medida/constante 120 px. O layout de duas colunas é uma adaptação funcional; não é uma nova comparação pixel a pixel do Discord nem reprodução de seu painel lateral de widgets. A confirmação de descarte é comportamento próprio para proteger rascunhos.

### Ponte e privacidade

O limite de 64 KiB por mensagem do host permanece. A interface envia arquivos em blocos de 24 KiB binários (32 KiB base64), com uploadId emitido pelo núcleo, offsets estritos, tamanho declarado, timeout de 30 s do buffer incompleto e limites avatar 512 KiB/faixa 1 MiB. Há apenas um buffer e uma requisição de mídia em andamento por CoreSession. O núcleo valida os campos, sessão e catálogo de formatos; o backend continua validando conteúdo, dimensões e orçamento.

Tokens e URLs arbitrárias não são fornecidos ao renderer. As imagens são buscadas pelo C++ via cache limitado existente e publicadas como data URLs. A origem deve ser a mídia da própria conta no Worker auth ou, para avatar Google, HTTPS em googleusercontent.com. O DTO do editor seleciona explicitamente campos próprios e inclui a nota apenas para o próprio usuário; nunca inclui email/sessionHash/token. Trocar conta ou sair limpa perfil e buffer; callbacks de conta anterior não atualizam a nova sessão.

Removemos o payload de todos os logs “ui -> core”, pois ele passaria a registrar imagens, chat e notas privadas. Os logs mantêm só o nome do comando. Os prazos das promises de perfil cobrem os prazos da rede nativa; timers de resultados já recebidos são cancelados.

### Menus de áudio

As setas dos controles de entrada/saída antes enviavam um comando sem efeito. Agora abrem menus reais a partir do painel da conta e da barra da chamada: dispositivo atual, submenu de dispositivos, volume e “Configurações de voz”. Lista vem do C++; escolhas/volumes são aplicados aos serviços e persistidos nas mesmas QSettings usadas pelo cliente Qt. O padrão Windows sempre pode ser escolhido; não inventamos IDs ou dispositivos ausentes.

Geometria vem de `out/claude-observations/ACCOUNT_PANEL.md`: menu 222 px, linha de dispositivo 52 px, bloco de volume 58 px e submenu 208 px. Perfil de entrada, opções sem motor e controles sem comportamento não são mostrados. O submenu vira de lado e limita altura quando necessário. Escape/clique fora fecham; foco volta ao botão e o chevron acompanha aberto/fechado. Enquanto o menu/modal está aberto, o mecanismo existente suspende overlays nativos para não cobrirem o DOM.

## Testes

- TypeScript e build web passaram; CMake `triscord-web` e cópia de assets passaram.
- Novo `tests/e2e/run_web_profile_e2e.py`: 20 verificações passaram com cliente real, Workers/D1 locais, contas e imagens sintéticas. Verifica prévia, salvar, redefinir, cancelamento de descarte, upload PNG >64 KiB em múltiplos blocos, GIF, remoção/reenvio, bytes servidos, imagem inválida, offset inválido, campos privados protegidos, ausência de credenciais/upsell, privacidade do perfil público, preservação do avatar no login seguinte, Escape apenas na camada superior e reabertura com os campos salvos. Relatório: `out/web-profile-e2e-report/`.
- Novo `tests/e2e/run_web_audio_menu_e2e.py`: abre entrada/saída, altera volumes, escolhe Windows padrão, abre configurações, verifica Escape/foco e persistência em nova instância. Oito verificações, com áudio injetado silencioso. Relatório: `out/web-audio-menu-e2e-report/`.
- Regressões `run_web_settings_e2e.py` e `run_web_auth_e2e.py` passaram nesta rodada. Settings inclui tema/nome/saída/persistência; auth inclui Google falso com verificação real do Worker, nome, servidores, convites e criação de sala. São testes locais; nenhuma conta real ou microfone/câmera física foi usado.

O harness local do Claude precisava encaminhar `/media/` para auth, além de `/auth-service/`; corrigimos essa lacuna para que imagens publicadas fossem realmente baixadas durante o E2E. No primeiro driver, vários inputs na mesma tarefa expuseram uma atualização de rascunho baseada em estado antigo; foi trocada por atualização funcional. Interações entre input/click no driver agora aguardam o render correspondente.

## Continuação: cartão da conta e status personalizado

`AccountPopover.tsx` abre ao clicar no painel da conta. Mostra avatar estático, faixa, nome, usuário, pronomes e bio próprios, com acesso ao editor e confirmação de saída reutilizada das configurações. A nota privada não aparece no cartão. O popover se ajusta à janela, tem rolagem em janelas pequenas e mantém Tab dentro dos controles; Escape e clique fora fecham e restauram o foco. Ao sair, o App limpa o estado das telas abertas para não reabri-las na próxima conta.

Status personalizado usa o campo de texto `status` que o hub já aceita, sem alteração nos Workers. O comando novo `setCustomStatus` exige sessão, string com até 64 unidades UTF-16 e rejeita controles ASCII. O C++ salva em QSettings sob a identidade da conta, envia no `join-room` e atualiza a sala por `user-state-change`. O DTO inclui `account.customStatus` e `VoiceUser.customStatus`; os participantes recebem o texto como tooltip na lateral. O texto é renderizado por Preact, sem HTML, e o payload não vai aos logs de comandos. O painel da conta trunca textos longos.

A persistência é local por conta/computador, não um perfil sincronizado entre dispositivos. O status não tem expiração automática. Disponibilidade, ausência, invisibilidade e não perturbar continuam sem semântica de presença no backend; não foram simulados com um indicador local. O desenho do popover é uma adaptação com componentes e tokens existentes, sem alegação de paridade pixel a pixel com Discord.

E2E novo: `tests/e2e/run_web_account_e2e.py`, duas instâncias WebView2/C++ e Workers/D1 descartáveis, sem áudio físico. As 22 verificações passaram. Relatório/capturas em `out/web-account-e2e-report/`. Verifica foco/Tab/Escape, editor, cancelamento da saída, validação nativa, estado inicial ao entrar, alteração/remoção recebidas pela outra instância, painel/tooltip, persistência após reiniciar e separação entre contas no mesmo diretório de configurações. Um observador de todos os deltas verifica também que o status de Alice não altere Bob, inclusive transitoriamente. Typecheck/build C++/web passaram; as regressões de perfil (20 verificações) e configurações (6) foram executadas novamente e passaram. Captura final do cartão revisada; pacote Qt preservado, sem commit/deploy.

## Continuação: perfis públicos de participantes

O participante da lateral abre um cartão público por clique, Enter/Espaço ou menu de contexto “Ver perfil”. O cartão sem vídeo da chamada também abre o perfil. A própria conta abre o editor existente. O cartão público mostra nome de exibição, usuário, pronomes, bio, faixa/avatar, data de criação e estado atual de voz/status. Não inclui mensagens diretas, ações de moderação ou botões sem suporte. A geometria 400×140/120 reaproveita a evidência já registrada para o cartão de perfil; o modal centralizado é uma adaptação funcional, não uma comparação pixel a pixel do popout do Discord.

`getParticipantProfile` recebe somente socketId. O C++ resolve a identidade por `userId`/`authenticated` enviados pelo hub e rejeita sockets fora da lista atual ou identidades não autenticadas. A consulta pública não leva Bearer. Resposta limitada a 64 KiB/15 s, com apenas uma consulta ativa; nova consulta/fechamento cancela a anterior. DTO explícito omite nota privada, email, tokens e URLs de origem. Geração, sessão e identidade atual são verificadas antes de aplicar a resposta. Saída do participante, troca de servidor, desconexão e logout limpam o cartão. Convidados têm somente os dados básicos da sala e não podem herdar o avatar de uma conta usando um userId alegado.

Imagens passam pelo cache nativo existente, limitado a 8 MiB comprimidos e 2 MiB por download, com origem restrita à mídia da conta no auth Worker ou avatar HTTPS Google. O novo caminho rejeita dimensões acima de 4096×4096 e entrega primeiro quadro PNG reduzido: avatar até 128×128 e faixa até 600×210. GIF não anima continuamente na lateral/chamada. O cartão recebe dados locais e o avatar consultado passa a aparecer na lateral e no cartão da chamada. Cache de avatares consultados limitado a 16 contas e limpo ao desconectar. Não há busca automática de todos os perfis nem sincronização em tempo real de mudanças externas de foto: abrir/reabrir consulta novamente os metadados. O tema público usa uma camada escura e texto claro para preservar leitura sobre cores personalizadas.

Escape/clique fora fecham; Tab permanece no cartão e o foco retorna à origem. Carregamento, erro e tentativa novamente têm estados próprios. A conferência visual encontrou uma conversão incorreta da data (o Worker usa milissegundos); corrigida e incluída na validação. E2E: `tests/e2e/run_web_participant_e2e.py`, duas instâncias reais, Workers/D1 locais e imagens/contas sintéticas. As 21 verificações finais passaram, incluindo imagens locais/lateral/chamada, privacidade, data, socket desconhecido, campos extras, menu de contexto, cancelamento, saída/reentrada e reabertura. Typecheck/build passaram; regressões de chamada com câmera sintética (7) e conta/status (22) passaram. Captura final revisada. Relatórios em `out/web-participant-e2e-report/`. Sem commit, deploy ou substituição do pacote Qt.

## Continuação: controles locais da voz de participantes

O menu de contexto da lateral e dos cartões sem vídeo da chamada ganhou “Áudio do participante”. Abre um diálogo com volume 0–200%, posição estéreo −100–100%, “Silenciar somente para mim” e redefinição para 100%/centro/ativo. O mesmo bloco está no perfil público quando o participante está na chamada atual. Há indicador “Silenciado para você” na lateral, mantendo separado o estado real do microfone remoto. Tab/Escape/foco estão cobertos no diálogo. Campos e geometria reaproveitam o cliente Qt existente (`main_window.cpp`, menu do usuário) e os sliders/Modal da interface; a disposição em diálogo é uma adaptação funcional.

O comando `setPeerAudio` valida socket presente na sala conectada, rejeita a própria conexão, tipos incorretos, números fora dos limites, frações, campos extras e atualizações vazias. Encaminha para `VoiceService::setPeerVolume/setPeerPan/setPeerMuted` na thread de mídia; não envia mudança de estado do microfone ao hub. Estado canônico vai no DTO do participante e fica separado por conexão, apenas na sessão atual. Saída do participante, troca/saída de sala ou desconexão removem os ajustes; não há persistência em disco. Estes controles tratam a voz: não ajustam a trilha de compartilhamento de tela nem efeitos do soundboard. Pan depende de saída estéreo; saída mono usa o volume/silêncio e ignora a posição, como no motor existente.

A rotina que consome as filas PCM foi extraída para `VoiceDevices::mixNextFrame`, usada pela reprodução normal e pelo novo teste `peerControlsApplyToQueuedPcmAndResetOnRemoval`. O teste verifica amostras reais da mistura: ganho individual, pan nos dois canais, silêncio, volume zero, remoção/restauração, ganho mestre, mono e deafen. A suíte `native-voice` passou sem abrir captura/reprodução física. O E2E `run_web_peer_audio_e2e.py` passou em 29 verificações com duas instâncias WebView2/C++ e Workers locais, incluindo valores do núcleo, perfil/menu, limites e alvos inválidos, fechamento e reset ao sair/reentrar e ausência de alteração no outro cliente. Typecheck/build passaram; regressões de perfil público (21) e chamada/câmera sintética (7) passaram. Captura revisada; sem commit/deploy ou substituição do pacote Qt. Relatório/captura: `out/web-peer-audio-e2e-report/`. O E2E usa áudio injetado silencioso; não é uma avaliação de qualidade ou latência dos dispositivos físicos.

## Continuação: tela cheia e controles dos vídeos

O botão “Tela cheia” da chamada usa `QWindow::showFullScreen`, com estado publicado pelo host para o núcleo/interface. Esconde título, lateral e chat por CSS, preservando os componentes montados, conexão, câmera e rascunho do chat. Ao sair pelo botão/Escape, restaura geometria anterior ou estado maximizado. Sair/trocar de sala, desconectar ou encerrar sessão também encerra o modo. A entrada exige chamada conectada e selecionada. Modais e menus recebem Escape antes da saída da tela cheia. Há indicação temporária de Escape e controles acessíveis por teclado mesmo quando o comportamento de inatividade os esconde.

Cada vídeo/transmissão ganhou barra DOM de 40 px abaixo da superfície nativa: perfil, áudio do participante quando aplicável e ocultação local. A janela nativa cobre só a superfície; não intercepta os botões. Isto também integra perfil/áudio ao cartão com câmera, antes inacessível por causa da janela nativa sobre o DOM. `setStreamHidden` valida stream existente e booleano; ocultação remove a janela de desenho e deixa um placeholder com opção de mostrar novamente. Frames novos continuam recebidos/decodificados, mas não são encaminhados ao desenho daquele stream; não é redução de banda ou desligamento de câmera/compartilhamento. Identificador oculto é limpo quando o stream termina ou a chamada é deixada. O estado da câmera remota permanece verdadeiro.

ResizeObserver e eventos de resize/layout recalculam a superfície ao entrar/sair da tela cheia. A janela de vídeo encaminha Escape e atividade do ponteiro; eventos de movimento são limitados a um por 80 ms, sem timer ocioso, para acordar os controles que o DOM não perceberia sob o vídeo nativo. A geometria do botão/ícone de tela cheia reaproveita CALLS.md e o ícone já extraído; a nova barra do vídeo e o aviso são adaptações funcionais, sem alegação de paridade visual integral.

E2E novo: `run_web_call_view_e2e.py`, dois clientes reais e Workers/D1 locais, áudio silencioso e câmera sintética. As 29 verificações passaram: janela nativa, tamanho normal/maximizado restaurado, preservação do rascunho, precedência de Escape no modal, comandos inválidos, ausência da janela de vídeo enquanto oculta, retomada dos frames, câmera remota preservada, acesso a perfil/áudio, saída/troca de sala, reentrada e evento de atividade. Typecheck/build passaram; regressões de áudio dos participantes (29) e chamada/câmera sintética (7) passaram. Sem commit/deploy/alteração do pacote Qt. Relatórios: `out/web-call-view-e2e-report/`. A captura WebView não inclui as janelas de vídeo: o harness salva imagens `.overlay-*.png` separadas com posição e nome do stream, revisadas junto à página. DPI diferente de 100%, múltiplos monitores e movimentação/tecla física sobre a superfície nativa ainda requerem QA; o teste de atividade injeta o evento de protocolo para verificar o comportamento da interface.

## O que continua faltando

- Modos de presença e expiração do status; moderação de participantes, controles adicionais de transmissão e política de atualização/precarregamento de avatares/perfis. O acesso ao perfil a partir de autores do chat ainda não está integrado.
- Paridade visual integral dos estados, foco preso/teclado de todos os menus e animações específicas do perfil; o novo editor é funcional, com evidência de componentes, não pixel perfect.
- Notificações sem Qt Widgets; opções adicionais de voz/captura que tenham função real e evidência; janela destacada/PiP e opções adicionais da chamada ainda não migradas.
- Medição de memória/CPU com imagens grandes e várias trocas de perfil, áudio/dispositivos físicos, câmera física e chamada WAN. Não atribuir o resultado silencioso dos E2E à qualidade física desses caminhos.
- Pacote web para distribuição e substituição consciente do Qt: o launcher atual depende da toolchain e do runtime WebView2; o pacote da Área de Trabalho continua Qt Widgets.

Arquivos em `desktop/out/` são evidências locais ignoradas pelo Git. As mudanças desta rodada estão no checkout nativo compartilhado, sem commit. Não executar builds ou E2E Qt simultâneos.

## Recado do Claude Code (17/10/2026, tarde)

Enquanto o Codex mede desempenho, o Claude fez **notificações sem Qt Widgets** no cliente web, para evitar trabalho duplicado:
- `NotificationPolicy` (`triscord_core`) agora é usada pelo `DesktopNotifications` do Qt e pelo núcleo web;
- `WinNotifier` (Win32, `Shell_NotifyIconW`) e o alerta da barra de tarefas ficam no `web_main`;
- página Configurações › Notificações; chaves `desktopNotifications` e `taskbarAlert`;
- E2E `run_web_notifications_e2e.py` (5/5).

Antes, o Claude também alinhou o soundboard ao CSS recuperado do Discord e pôs "Volume dos efeitos sonoros" nas Configurações (`soundboardVolume`).

Para não disputar a mesma árvore Ninja: `scripts/build.ps1 -BuildDir out/build-claude` (opcional; o padrão continua `out/build`). Detalhes em ARQUITETURA_WEBVIEW2.md (Fases 8 e 9).


## Continuação: recursos e ciclo de vida da câmera

Benchmark local aprovado em oito ciclos com dois clientes e processos WebView2 isolados. Dez verificações passaram; relatório completo em `RECURSOS_WEB_20261017.md`, reprodução em `tests/e2e/RESOURCE_BENCHMARK.md`. No cliente principal, privada mediana de 227,1 MiB antes, 311,6 MiB nas chamadas e 255,6 MiB após; pico geral 331,2 MiB. O aumento residual privado foi 28,5 MiB; não é demonstração de ausência de vazamentos. Fonte sintética 640×360 recebida em 320×180, áudio silencioso, sem medir hardware/WAN/1080p. O working set somado é outra métrica e inclui páginas compartilhadas.

A câmera aguarda prontidão de mídia antes de iniciar, com estado pendente cancelável e prazo de dez segundos. Sair/desconectar limpa a intenção, e frames atrasados fora da chamada não recriam os vídeos. O teste de chamada ganhou cancelamento e reinício da câmera: nove verificações passaram. O benchmark confirma reativação nas oito entradas e desenho nativo a cada chamada. A automação do emissor minimizado usa eventos, porque o navegador suspende polling por temporizadores em segundo plano.

A lista anterior de pendências de recursos foi parcialmente atendida por este ensaio específico. Continuam câmera/áudio físicos, WAN, imagens no limite de upload, sessões longas e carga de vídeo em alta resolução. Notificações sem Qt Widgets já foram implementadas pelo Claude, conforme o recado acima; a referência anterior é histórica. Pacote distribuído Qt preservado; desenvolvimento web permanece no launcher separado.

Validação final desta rodada: typecheck/build da interface, chamada 9/9, tela cheia/ocultação 29/29 e CTest native-core/native-voice/native-camera 3/3 passaram. Nenhum teste/build Codex em execução ao encerrar.

## Janela destacada (Claude Code, 17/10/2026)

A chamada pode ir para uma janela própria: "Nova Janela" na bandeja inferior direita, quando a chamada tem vídeo.
- **Na janela destacada:** "Mostrar sempre" / "Remover do topo".
- **Na janela principal:** a mensagem do Discord e "Voltar para o Triscord".
- **Fechamento:** pelo botão, pelo sistema, ao sair da chamada ou ao trocar de sala.

O PiP dentro do app não se aplica, porque não existe navegação para fora da chamada. Evidência, arquitetura e limites em ARQUITETURA_WEBVIEW2.md, Fase 10. "Tela cheia" dentro da janela destacada também foi feita (Fase 10b): só a janela pop-out entra em tela cheia, e o Esc sai.


## Retomada do Claude: moderação na sala

Concluída a integração que o Claude interrompeu por limite da sessão: grupo de moderação nos menus de participante da lateral/chamada, caixa marcada/acessível e ícone crítico. Props da bridge corrigidas; foco do menu e ativação por Espaço/Enter. O dono da sala pode silenciar (inclusive a si) e desconectar terceiros. Validação C++ exige autoridade e presença na sala atual; o hub mantém a autorização final. Restrição de microfone persiste ao reentrar, impede dessilenciar e sua retirada não ativa o microfone automaticamente. Transferência da sala remove/adiciona os controles conforme a autoridade atual. Não há ensurdecimento de terceiros ou banimento.

Build C++ e typecheck/build web passaram; E2E de moderação final 35/35. Evidências e reprodução em `MODERACAO_WEB_20261017.md`. Pacote da Área de Trabalho não substituído nesta retomada. Notas anteriores sobre moderação pendente são históricas para esses dois controles; funções adicionais continuam sem implementação.

Regressões finais da moderação: áudio local 29/29, janela destacada/tela cheia 14/14 e CTest 12/12 aprovados após o ajuste de foco. Nenhum build/E2E Codex ativo.

## Opções de transmissão (Claude Code, 17/10/2026)

**No seletor de compartilhamento:**
- bloco "Jogos" / "Compartilhamento de tela", com a linha de qualidade;
- SD/HD (720p/1080p);
- engrenagem com "Modo de transmissão" e "Silenciar áudio da transmissão".

As escolhas ficam salvas nas mesmas chaves do Qt, e o núcleo transmite com o preset escolhido.

**Para quem assiste:** "Volume da transmissão" e "Silenciar transmissão", no diálogo de áudio e no menu do participante.

E2E `run_web_stream_options_e2e.py` 12/12. Detalhes em ARQUITETURA_WEBVIEW2.md, Fase 12.

**Ainda fora:** "Personalizada", "Avançado" e a aba Dispositivos. Os selos do cartão (Fase 12b) e a visão ampliada com as pílulas no cabeçalho (Fase 13) já foram feitos.


## Entrega web real e janela principal sem moldura

Retomado o último pedido da conversa Claude. Janela principal sem moldura confirmada nas capturas e no release, com barra de título também no login. Corrigido o problema de entrega: o script usado antes empacotava Qt Widgets. O novo `scripts/portable-web.ps1` compila/valida o WebView2 release com interface/fontes/loader e sem CLI de testes. O portátil web validado foi copiado para a Área de Trabalho, com backup do Qt e hash conferido. Relatório e limites em `ENTREGA_WEB_20261017.md`.

Verificações: release 21/21, portátil extraído 23/23, chamada 29/29, pop-out 17/17 e CTest 12/12. As notas anteriores de “pacote Qt preservado” são históricas: a partir desta entrega, `Desktop/triscord.exe` é o cliente web. Usa o runtime WebView2 do Windows e não precisa da toolchain. Nenhum build/E2E Codex ativo. Sem publicação de Workers ou commit.


## GIF do próprio avatar na chamada

O cartão próprio usa o GIF original já validado em `profile.avatarDataUrl`, em vez do PNG estático do diretório. PNG usa a miniatura atual da conta, corrigindo também troca/remoção sem esperar o diretório da sala. Sem novos downloads ou frames pela ponte. E2E visual 13/13 com oito quadros distintos antes/depois de reentrar e PNG estático; chamada 29/29, release 21/21 e portátil 23/23 passaram. Executável da Área de Trabalho atualizado; a chamada em andamento foi preservada e a atualização aparece ao reabrir. Comportamento de avatares de terceiros não alterado. Detalhes/hashes: `GIF_CHAMADA_20261017.md`.
