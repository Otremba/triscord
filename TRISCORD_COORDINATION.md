# Estado atual do Triscord

- Cliente principal: `desktop/src` (C++20/Qt) e `desktop/web` (Preact/WebView2).
- Branch principal: `main`. A versão nativa publicada é `desktop-v0.9.43`.
- Download: https://triscord.pages.dev . Releases nativas e Electron antigo têm canais separados; a ponte de migração ainda não foi implementada.
- Servidor Node em `server/` é mantido por compatibilidade e por ferramentas/testes locais. Os serviços do cliente distribuído ficam em `cloudflare/` e `cloudflare-auth/`.
- Não executar E2E sem nova instrução do usuário. A CI padrão não os executa. Compilações/testes Qt e empacotamento devem ser sequenciais.
- Falhas intermitentes de tela preta receberam correções em 0.9.32, mas precisam de confirmação nas máquinas afetadas. Não afirmar que a validação física foi concluída.
- Não versionar credenciais, SDKs, caches ou binários de build. Não usar produtos pagos.

[Guia do projeto](README.md) · [Cliente](desktop/README.md) · [Histórico](docs/history/README.md)

**Publicação atual (19/10): versão 0.9.36 disponível**, commit `3172188`, release `desktop-v0.9.36` (`make_latest: false`). Inclui correções de qualidade da imagem e buffer de áudio. Compilação e empacotamento autorizados; nenhum teste, aplicativo ou instalador executado (`runtimeVerified=false`). Site publicado em `6124981e.triscord.pages.dev`, com alias `triscord.pages.dev`; `/download` entrega a 0.9.36. Download público conferido por SHA-256. Wrangler deslogado ao terminar. As entradas abaixo são históricas; a pendência de deploy da 0.9.35 foi resolvida.

**Claude Code (19/10, tarde): histórico resetado e versão 0.9.35 publicada**, a pedido do usuário.
- **Histórico:** a `main` agora é a única branch e tem 1 commit inicial (só o usuário como autor), mais o bump de versão. Todas as outras branches e as 16 tags foram apagadas, local e remotamente, e os 16 releases antigos também. O histórico antigo só existe no backup `DocumentsGitHub	riscord-backup-all-refs-20261019all-refs.bundle` e nos objetos locais não alcançáveis. Os worktrees do Codex estão em HEAD solto: `native-desktop` no commit novo (arquivos idênticos); `backend-media` continua em `e189dad` (427 arquivos diferentes, não mexi). Os 3 commits de `feat/backend-media` e o de `fix/sfu` só estão no backup.
- **Padrão de commit:** uma linha `tipo: resumo`, em inglês, sem escopo, sem corpo, sem trailers, sem versão no commit (a versão fica na tag). Tipos: feat, fix, docs, chore, refactor, test, perf, build, ci. Commits direto na `main`.
- **Release `desktop-v0.9.35`** (`make_latest: false`), compilado do commit `3905156` com `portable-web.ps1 -SkipRuntimeVerification` (`runtimeVerified=false`; o usuário podia estar em chamada). Instalador 43.619.795 bytes, SHA-256 `1d4fde55…ff58a`, conferido baixando pelo link público. Sem E2E. A lógica do atualizador (`update_splash.cpp`) foi reproduzida contra a API: 0.9.34 e anteriores baixam a 0.9.35; a 0.9.35 não atualiza. O app instalado não foi aberto.
- **Site:** o botão de download do site ao vivo aponta para a 0.9.32, que deixou de existir (404). O site foi montado de novo (`node site/stage.mjs`, aponta para a 0.9.35), mas **não foi publicado**: falta o OK do usuário para o `wrangler pages deploy`.
- **Render:** cada push na `main` cria um deployment "main - triscord" (Render, `triscord.onrender.com`).

**Claude Code (19/10): bandeja, abrir no login e instância única** (branch `feat/native-window-lifecycle`, a partir de `76c2b9b`; não mexe no worktree do Codex). Sem versão, sem publicação, sem E2E. Build `out/build-lifecycle` OK, CTest 12/12 (`native-core` 17 testes, 6 novos).
- **Instância única** (`SingleInstance`, `window_lifecycle.*`): mutex `Local\TriscordWeb-<hash do TRISCORD_SETTINGS_PATH>` + socket local só do usuário. Uma segunda execução traz a primeira à frente e sai, antes de abrir o log (senão rotacionaria o log da primeira). Cada E2E, com seu `TRISCORD_SETTINGS_PATH`, tem a própria instância.
- **Bandeja** (`WinNotifier::setResident`): ícone fixo com menu "Abrir o Triscord" / "Sair do Triscord"; refeito quando o Explorer reinicia. O botão fechar esconde a janela (a chamada e a janela destacada continuam) e avisa uma vez. "Sair" ou o logoff do Windows encerram de verdade.
- **Abrir no login**: valor `Triscord` em `HKCU\...\Run` com `"exe" --startup`, lido de volta do registro. "Abrir minimizado" vale só para essa partida. Build de desenvolvimento e E2E não registram nada (`loginSupported`).
- **Configurações › Configurações do Windows**: três chaves (`openAtLogin`, `startMinimized`, `closeToTray`; padrão: bandeja ligada, o resto desligado).
- **E2E/testes**: com `TRISCORD_SETTINGS_PATH` a bandeja fica desligada (fechar encerra como antes), salvo `TRISCORD_TRAY=1`.
- **Testado em execução** (build `out/build-lifecycle`, configuração isolada com `TRISCORD_SETTINGS_PATH` e `TRISCORD_TRAY=1`, sem tocar no Triscord instalado, que estava numa chamada):
  - segunda execução saiu em ~200 ms e trouxe a primeira de volta (minimizada ou escondida), sem segundo processo;
  - WM_CLOSE na janela escondeu para a bandeja (processo vivo, aviso gravado uma vez);
  - o ícone aparece na bandeja (tooltip "Triscord") e some ao sair;
  - menu da bandeja: abrir "Abrir o Triscord" restaurou a janela e "Sair do Triscord" encerrou o processo (menu acionado por mensagem + teclado ao próprio processo, porque o shell não aceita clique direito do computer-use);
  - partida com `--startup` e "Abrir minimizado" ficou escondida; uma execução normal depois a mostrou.
- **Ainda não testado**: gravar/ler a chave Run do registro pelo botão (o build de desenvolvimento não registra nada, de propósito), o clique no X da barra de título (o caminho do WM_CLOSE é o mesmo evento de fechamento) e o encerramento no logoff (`commitDataRequest`).
- Pendente: `triscord://` (link de convite abrindo o app) ficou de fora; precisa do registro do protocolo no instalador NSIS.

**Claude Code (19/10, madrugada): versão 0.9.34 publicada a pedido do usuário** (release `desktop-v0.9.34`, `make_latest: false`). Sem E2E. O pacote foi gerado com `-SkipRuntimeVerification` (o usuário estava jogando). CTest 12/12.
- **Vozes robóticas (receptor):**
  - A placa de som agora puxa os quadros (`VoiceDevices::setFrameSource`). Antes, dois timers de 20 ms entregavam um quadro por disparo, e um disparo atrasado esvaziava o buffer da saída para sempre.
  - O jitter buffer espera o pacote atrasado em vez de descartá-lo e adapta a profundidade (3 a 8 pacotes).
- **Vozes robóticas (quem fala):**
  - As threads de voz rodam em `HighestPriority`.
  - A fila de supressão de ruído só descarta quadros acima de 100 ms (antes, 60 ms).
- **Transmissão ruim para quem assiste:**
  - O receptor de vídeo agora envia NACK, e os pacotes atrás de uma perda esperam até 150 ms pela retransmissão (`VideoRtpReorder`). Antes, cada perda congelava até chegar um novo quadro-chave.
  - A taxa de bits só cai com o buffer de envio cheio ou com 3 pedidos de quadro-chave em 5 s (`ScreenBitrateControl`), com piso de 1/8 do preset. Depois de 8 s calmos, sobe 20% a cada 4 s.
  - O decodificador é esvaziado antes de recusar uma rajada de quadros, e a fila de quadros aceita 12 em vez de 2.
- **Log** (`%LOCALAPPDATA%\Triscord\logs\triscord.log`):
  - linhas `video: N lost packets recovered…/M unrecoverable` a cada 10 s quando há perda;
  - linhas `screen|camera: bitrate X kbps…` a cada mudança de taxa.
  - Servem para saber se o problema é a internet de quem assiste.

**Claude Code (18/10, 23h): versão 0.9.33 publicada a pedido do usuário** (commit c9a5701, release `desktop-v0.9.33` com `make_latest: false`). Junta as correções de estabilidade do Codex e as do Claude nesta noite (abaixo). Pacote gerado com `portable-web.ps1 -SkipRuntimeVerification`, porque o usuário estava jogando e pediu que nada abrisse na tela. Só verificações estáticas do pacote, sem E2E.

**Claude Code (18/10, noite, 2ª sessão): revisão de chat, servidores/convites, soundboard e updater.** Sem E2E. Build `out/build-claude` OK, CTest 12/12.

Correções:
- **Chamada caía sem aviso** ao sair/excluir o servidor que você estava *vendo* durante uma chamada em outro servidor. O `refreshServers` movia a conexão principal. Agora volta a mostrar o servidor da chamada (`HubApi::planServerList`).
- **Reconexão infinita a servidor excluído:** acontecia ao excluir o servidor da sua chamada enquanto via outro. Também acontecia com membros de um servidor excluído pelo dono: o hub recusa com 403 para sempre e o servidor fica no trilho até reiniciar. Agora:
  - uma queda inesperada da sinalização recarrega `GET /servers`;
  - o cliente sai do servidor que sumiu.
- O `refreshServers` ignora respostas antigas ou que chegam depois de sair da conta. Antes, uma resposta dessas podia reconectar sem sessão.
- **Mensagem de chat perdida:** o core respondia ok mesmo quando o hub descartava a mensagem (limite de 500 ms) ou quando o socket não enviava. O painel então apagava o rascunho. Agora ele recusa com erro (intervalo mínimo de 600 ms, ou sem conexão), e o rascunho fica.
- Teste: `hub_api_tests::serverListPlanKeepsTheCallAndLeavesDeletedServers`.

Riscos não corrigidos:
- `worker.js:373`: o D1 é consultado a cada mensagem, o que permite reordenar mensagens do mesmo socket. Corrigir exige deploy do hub.
- Soundboard: o cliente e o hub usam o mesmo limite de 1000 ms, então o jitter gera recusas falsas.
- O timeout da UI (10 s) é menor que o do HTTP do hub (15 s) em createServer, o que pode duplicar servidores.

O updater não tem bug crítico. Detalhes em `side-session-notes/.../chat-servers-soundboard-updater-review-20261018.md`.

**Claude Code (18/10, noite): rodada de estabilidade do Codex compilada e concluída + bugs críticos.** Sem commit, sem versão, sem E2E (pedido do usuário).

Continuação do pedido "vozes robóticas / corrija tudo", que o Codex deixou sem compilar. Compila e passa no CTest 12/12.

Correções minhas:
- **Atraso preso:** o novo jitter buffer (até 200 ms) nunca drenava. Depois de uma rajada, o atraso ficava. Agora, acima de 80 ms por 1 s, ele decodifica e descarta um pacote (`voice_jitter.h`). Teste: `jitterRecoversLossWithFecAndDrains`.
- **Testes antigos:** os testes de jitter e o `screen_client_tests` ainda supunham o buffer antigo (2 pacotes / ≤5) e falhavam. Foram atualizados para 3 pacotes / ≤10.
- **Chamada caía e não voltava (crítico):** qualquer queda do socket de sinalização (Wi-Fi, redeploy do hub, timeout de heartbeat) tirava o usuário da sala, sem reentrar.
  - Agora o `CoreSession` reentra sozinho no primeiro `rooms-update` após reconectar, em até 60 s, no mesmo servidor.
  - Não reentra depois de sair de propósito, trocar de servidor ou sair da conta.
  - Câmera e tela não são religadas.
  - Sem teste automatizado: o `CoreSession` só existe no exe, e os E2E estão vetados.
- `ScreenCall::adaptBitrate` sem `members_.at`.

Observado e não corrigido: `native-ui` leva 27 s com limite de 30 s, então dá timeout sob carga (flaky).

Nenhum build ou teste do Claude está em andamento.

Os relatórios anteriores, incluindo resultados de testes e evidências REA, foram preservados em `docs/history/`. Instruções de agentes e estados de versões antigas nesses arquivos são históricos, não requisitos atuais.

**Publicação de 20/10: 0.9.41** (commit `3700906`, `make_latest: false`): envio automático de logs a cada 30 minutos também durante chamadas. Pacote com verificação em execução usando perfil isolado (`runtimeVerified=true`); instalador e checksum publicados, download público HTTP 200 com SHA-256 conferido. Site: `cd75bb37.triscord.pages.dev`. Wrangler deslogado; versões anteriores preservadas.

**Publicação do monitor (20/10): 0.9.42**, commit `0bfc342`, com diagnóstico/classificação de falhas de saída dos sons. Causa da falha ainda pendente. Pacote validado em perfil isolado, instalador e SHA-256 publicados, download público HTTP 200 com hash conferido. Pages `99378baf.triscord.pages.dev`; Wrangler deslogado.

**Monitor, 20/10: 0.9.43 publicada**, commit `bdc36ac`: corrige arredondamento do timer de captura, que podia descartar disparos alternados. Testes unitários sem interface passaram; sem E2E, captura ou execução de app/instalador (`runtimeVerified=false`). Download público com SHA-256 conferido. Site `30e3e85c.triscord.pages.dev`, republicado usando token Pages restrito, protegido por DPAPI fora do Git. OAuth do Wrangler permanece deslogado. Próximos deploys via `site/deploy.ps1`.

**Monitor, 20/10: reconexão por limite de sinalização corrigida no servidor**, commit `2f0316f`, Worker `e0302b2e`. Negociação WebRTC tem orçamento separado (256/s) do controle comum (40/s), evitando expulsar clientes ao negociar chamadas com vários participantes. Unitários Node + bundle passaram; health 200 após deploy, OAuth deslogado. Nenhuma release nativa nova: 0.9.43 continua atual. Sem E2E ou execução do aplicativo.
