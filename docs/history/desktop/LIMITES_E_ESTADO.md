# Estado verificado e limites reais (triscord nativo)

Atualizado em 15/10/2026 (paleta real do Discord aplicada; ver desktop/out/claude-observations/PALETTE.md). Este documento prevalece sobre `PROGRESSO_ANTIGRAVITY.md` e `IMPLEMENTATION_STATUS.md` quando houver divergência. Evidências visuais ficam em `desktop/out/claude-observations/*.md` (pasta ignorada pelo git, com capturas reais do Discord 1.0.9261 e do triscord) e em `desktop/out/discord-comparison-report/index.html`.

## Arquitetura gratuita e seus limites

- **Sinalização:** servidor Socket.IO (Node) ou Cloudflare Worker no plano gratuito. O Worker devolve `service-limit` quando o limite diário gratuito termina; o serviço volta no próximo dia UTC. Sem contratação, sem cobrança, sem créditos.
- **Mídia:** WebRTC ponto a ponto em malha. Cada participante envia o próprio áudio, câmera e tela para **cada** outro participante. Não existe SFU: o custo de upload cresce com o número de pessoas. O código limita a 9 pares por chamada e divide 70% do upload medido entre vídeo e voz (`quality_policy.h`). Uma conexão doméstica comum não sustenta várias transmissões em alta qualidade ao mesmo tempo.
- **NAT:** há STUN público gratuito (`stun.l.google.com` e outros) e, desde 16/10/2026, TURN gratuito da Cloudflare Realtime: depois do login, o cliente busca `GET /ice` no hub (`Authorization: Bearer <sessão>`), recebe credenciais válidas por 600 s e as coloca antes dos STUN; renova a cada 240 s enquanto houver sessão (`src/ice_config.cpp`, `MainWindow::refreshIce`). Os relés OpenRelay foram **removidos**: em 15/10/2026 `openrelay.metered.ca` resolvia para `192.0.2.1` (TEST-NET, sumidouro) no DNS do Google e da Cloudflare, ou seja, nunca funcionaram. O código tenta reconstruir o par até 3 vezes e avisa que a voz de um participante não conectou.
  - **Publicado:** desde a rodada do Codex de 16/10/2026 o hub em produção tem `/ice` e `/servers` (respondem 401 sem sessão, conferido às 14:30).
  - **Não verificado:** o cliente não foi exercitado com uma sessão real contra produção nesta rodada (só contra hub falso local). Nenhuma chamada real entre duas redes diferentes passou pelo TURN; os testes cobrem só o formato da resposta da Cloudflare e a ordem/validade das credenciais (`native-ice-config`, `native-hub-api`).
- **Equivalentes ao Nitro:** a qualidade de transmissão HD (1080p) fica liberada porque o limite real é o upload do usuário, não uma assinatura. Qualidade acima de 1080p não está implementada (sem pipeline de captura/encoder dedicado).

## Servidores (16/10/2026)

- Botão "Adicionar um servidor" no trilho (ícone CirclePlus do bundle, repouso `#1e1e20`, hover `#5865f2`), modal "Criar seu servidor" com os passos 1 e 3 observados em `out/claude-observations/SERVIDORES.md`, nome pré-preenchido "Servidor de <nome>" (texto do locale pt-BR). Servidores sem ícone aparecem com a sigla calculada pelo mesmo algoritmo do Discord (bundle, offset 11891250: "Servidor de camargo" → "Sdc").
- Clicar num servidor troca a conexão de sinalização para `?serverId=<id>&sessionToken=<sessão>`; o "Triscord" legado continua usando o convite do grupo. O último servidor aberto é lembrado.
- O dono vê o botão de convite (UserPlus, módulo 283973) no cabeçalho; clicar cria um convite e copia o código. Quem recebe usa "Entrar em um servidor" e cola o código (aceita o código puro ou qualquer texto que o contenha).
- A tela "Entrar em um servidor" foi refeita a partir do **código e CSS reais do Discord** recuperados do cache com REA (`REA_CLAUDE_20261016.md`): botão "Entrar no servidor", exemplo clicável que preenche o campo, mensagens de erro reais. Ainda não foi comparada com uma captura de tela. **Omitido:** passo 2, modelos ("Começar de um molde"), envio de ícone e o rodapé de diretrizes.
- **Não verificado:** criar/entrar/convidar com uma sessão real em produção (o Worker já foi publicado pelo Codex). Testado contra um hub falso local (`native-hub-api`) e na UI (`createServerDialogFollowsObservedSteps`). Um hub antigo sem `/servers` (404) mostra "O servidor de sinalização publicado ainda não oferece servidores".

## Perfil (16/10/2026)

- O editor ganhou o cartão ao vivo do Discord (faixa 400×140 e avatar de 120 px com anel de 8 px, valores de `MODAL_V2`). Medido na captura: imagem 120 px + anel = 136 px — o "~96 px" anterior estava errado; vale o 120 declarado.
- `nameplate` saiu do editor: no Discord é item da loja de colecionáveis com SKU (`nameplate_sku_id`), não texto livre; o triscord não tem catálogo. A coluna no servidor foi mantida.
- Tema de perfil segue a regra recuperada do CSS do Discord (primária até a altura da faixa, degradê para a secundária, preto a 60% por cima). **Inferido:** faixa sem cor usa `#121214`.
- Avatar e faixa por imagem (contrato `PUT/DELETE /profile/avatar|banner` do `cloudflare-auth/BACKEND_HANDOFF.md`): botões "Enviar imagem", "Remover avatar", "Alterar imagem da faixa" e "Remover faixa" (textos do locale pt-BR; a posição no formulário é do triscord). O tipo é detectado pelos bytes (PNG/JPEG/GIF), limites de 512 KB/1 MB conferidos antes de enviar; erro do servidor é mostrado e a imagem anterior fica. O GIF animado roda no cartão do editor; no painel da conta aparece só o primeiro quadro (sem custo de CPU parado). O avatar do painel agora é a imagem real (enviada ou do Google).
- **Não verificado:** upload real contra produção; avatares de outros participantes nas chamadas ainda são letras (a sinalização não transmite `avatar_url`).

## Fluxos principais: o que está verificado

Verificado por testes automatizados (suíte de UI 29, CTest 9) e por capturas, **sem** chamada real entre duas máquinas:
- Salas, lista de participantes na lateral (avatar, nome, estados, câmera, transmissão), cartões, chat com reações e exclusão, composer, soundboard, configurações de voz (dispositivos, volumes, atalhos), controles de mudo/áudio, seletor de compartilhamento, estados de câmera/transmissão no painel.
- **Reconexão:** ao perder a sinalização, o cliente avisa ("Você foi desconectado(a)... Segura firme, vamos te jogar de volta!", texto observado no Discord), reconecta com backoff exponencial e entra de novo na mesma sala; a câmera é religada se estava ligada. Desde 15/10/2026, a transmissão de tela segue o mesmo caminho: se a sala caiu enquanto a tela estava sendo compartilhada, a mesma fonte (janela ou monitor) e a mesma qualidade voltam a ser compartilhadas sozinhas depois do rejoin automático, sem o usuário escolher de novo. Sair da sala de propósito, ou parar a transmissão de propósito antes da queda, cancela o retorno (do mesmo jeito que cancela o da câmera). Se a fonte lembrada não existir mais na hora de retomar (janela fechada, monitor desconectado), o cliente não tenta retomar e não trava: `ShareSession::resumeShare` só chama o início real se a fonte (tipo, identificador e nome) ainda aparecer na lista atual de fontes capturáveis; e mesmo que chamasse, o caminho de início já existente (`ScreenCall::start`) captura qualquer exceção do encoder e mostra o aviso "Não foi possível compartilhar..." sem derrubar o processo — não foi inventado texto novo de interface. Testado contra um servidor WebSocket local com três testes novos ao lado do já existente (`reconnectRejoinsTheRoomAfterASignalingDrop`): `reconnectResumesScreenShareAfterASignalingDrop` (queda involuntária durante uma transmissão real de um monitor desta máquina retoma sozinha), `reconnectDoesNotResumeAScreenShareStoppedBeforeTheDrop` (parar a transmissão antes da queda não retoma) e `resumeShareIgnoresASourceThatNoLongerExists` (uma fonte inventada, que nunca existiu, é recusada sem exceção). Limite desta verificação: é um teste de loopback (servidor WebSocket na mesma máquina, sem rede real) — ele prova a lógica de lembrar/validar/retomar a fonte e a mensagem de erro existente, não o comportamento em uma reconexão de verdade pela internet, nem o caso de um monitor físico sendo desconectado enquanto o processo roda (não testado; só o caso de uma fonte que nunca existiu).
- **Pares de voz:** reconstrução automática de pares que não conectam (testes de voz).

## Verificação sem segunda pessoa (15/10/2026, esta máquina, loopback)

Executado em série com o servidor de sinalização real (`tests/signaling_fixture.cjs`, mesmo código do servidor) e `tests/integration_smoke.py`:
- Voz: 2, 3 e 10 clientes nativos recebem Opus decodificável e criptografado de todos os outros (WebRTC real em loopback); a voz volta em todas as direções depois que um cliente cai e entra de novo com nova sessão.
- Tela e áudio: 3 clientes trocam imagens de tela, voz da chamada e áudio da transmissão separado ao mesmo tempo, com pausa de vídeo, silêncio do áudio da transmissão independente, mudo da sala imposto pelo receptor e limpeza ao parar a transmissão.
- Câmera e tela simultâneas: papéis e pixels verificados, grade reduzida a 320x180, foco em 1280x720, parar uma câmera preserva as telas e a outra câmera.
- Dispositivos de áudio reais: mudo, desativar/retomar áudio, rejeição de dispositivo indisponível e recuperação do dispositivo padrão passaram (`triscord-audio-smoke`, silencioso).
- Áudio do sistema na transmissão: com um segundo processo tocando um tom, a captura WASAPI pegou o áudio do outro aplicativo e excluiu o áudio do próprio processo (`triscord-system-audio-smoke --tone` junto com `--capture`).
- Câmera física: o Qt não encontrou nenhuma câmera nesta máquina (`Native cameras: 0`); a câmera foi verificada só com quadros sintéticos.

- **Sinalização pela internet (Worker real):** o mesmo teste de 3 clientes (tela, voz, áudio separado da transmissão, pausa, mudo da sala imposto pelo receptor, rejoin e limpeza) passou com a sinalização no Worker gratuito do projeto (`triscord-control`, Cloudflare), usando a sala de validação dedicada e o convite local (não impresso). A mídia continua em loopback: o teste injeta áudio e vídeo sem contatar o STUN, então prova o caminho de sinalização de produção, não a travessia de NAT.

- **NAT desta conexão (medido hoje com `tools/nat-probe.cjs`):** o mesmo socket UDP perguntou a três servidores STUN públicos do Google e recebeu a mesma porta mapeada em todos, ou seja, mapeamento independente do destino. UDP sai e volta, e a conexão direta ponto a ponto deve funcionar deste lado. Ressalvas: o Cloudflare WARP está instalado nesta máquina e pode estar no caminho; e isso diz como é **este** lado, não o do outro participante nem se os dois NATs conseguem furar um ao outro.

Limite dessa verificação: tudo em loopback, na mesma máquina. Não prova NAT, perda de pacotes, latência nem desempenho de upload entre redes diferentes.

## O que NÃO está verificado

- Chamada de voz, câmera e tela entre duas máquinas em redes diferentes (WAN): NAT, latência, perda e qualidade. Webcam física e efeitos de fundo também dependem de teste real.
- Vídeo real da transmissão e da câmera no Discord: não foi possível observar (o Discord mostrou erro de conexão do servidor de transmissão), então o estado "assistindo" não tem par visual real.
- Fidelidade "pixel perfect": as medidas foram comparadas em cada tela observada, mas diferenças de renderização de fonte (ClearType/Chromium contra Qt), arte de emojis e avatares existem e o tema preto foi revogado (a paleta agora é a medida no Discord). Não há comparação automática pixel a pixel em todos os estados.
- Estados do Discord nunca observados (lacunas registradas nos arquivos de `claude-observations`): aba Dispositivos do seletor, "Personalizada" e "Avançado", status do canal, perfil do participante, mensagens de hoje e ontem, menus completos de mensagem.

## Comparação automática de layout

`desktop/tools/visual-review/layout-lines.ps1` compara linhas de layout entre capturas do Discord e do triscord no mesmo tamanho. Resultados e limites em `desktop/out/claude-observations/LAYOUT_COMPARISON.md`: a geometria coincide até 1 px onde medi direto, mas o quadro inteiro não é pixel perfect.

## Correção de alegações antigas

A tabela "Equivalente" de `PROGRESSO_ANTIGRAVITY.md` foi escrita sem comparação por captura no mesmo estado e não prova paridade. Use os relatórios acima.

## Requisitos não funcionais medidos (15/10/2026)

Meta do projeto: cliente em C++ que consome poucos recursos. Medição do pacote `triscord.exe` (SHA-256 97858329…) aberto e ocioso (sem sala), Windows 11, 15 s de amostra:

| Métrica | triscord (`triscord-native`) | Discord instalado (6 processos, ocioso) |
|---|---|---|
| Memória física (working set) | ≈ 89 MB | ≈ 1.046 MB (soma) |
| Memória privada | ≈ 64 MB | ≈ 766 MB (soma) |
| CPU | 0 ms em 15 s | 31 ms em 15 s (0,21% de um núcleo) |
| Threads / processos | 17 / 1 (+1 lançador do arquivo único) | 6 processos |

Nova medição em 16/10/2026, pacote SHA-256 `056166e1…` (com servidores, TURN e prévia de perfil), aberto e ocioso: ≈ 89–90 MB de memória física, ≈ 65,5 MB privada, 25 threads; CPU 0 ms em três janelas seguidas de 10 s (uma janela logo após abrir registrou 94 ms, das respostas de rede iniciais).

Medição seguinte, 16/10/2026 14:3x, pacote `0f82df82…` (com upload de avatar/faixa): 91,8 MB físico, 67,7 MB privada, 26 threads, 0 ms de CPU em três janelas de 10 s.

Limites desta medição: o Discord foi medido na sessão do usuário (janela aberta, sem chamada) e não numa condição controlada; o triscord foi medido sem sala, sem voz, sem câmera e sem compartilhamento. Em chamada, câmera e tela o consumo sobe (codificação de vídeo, WebRTC, captura) e **ainda não foi medido**. Não há meta numérica adotada (orçamento de memória/CPU) — precisa ser definida e medida em chamada antes de afirmar que o requisito foi atendido.

### Custo isolado do processamento de voz (`triscord-voice-bench`, esta máquina, 5.000 quadros de 20 ms)

| Processamento | média | p95 | máximo |
|---|---|---|---|
| Opus sem filtros | 88 µs | 103 µs | 292 µs |
| + supressão de ruído | 141 µs | 184 µs | 391 µs |
| + cancelamento de eco | 254 µs | 323 µs | 606 µs |
| + ambos | 245 µs | 261 µs | 324 µs |

Cada quadro tem 20 ms de orçamento: a média fica em 0,4–1,3% de um núcleo por fluxo de saída. É só DSP + Opus sintético, sem dispositivo, rede, UI nem vídeo; **não** representa o consumo do aplicativo em chamada. Vídeo (codificação de câmera/tela) ainda não foi medido.

### Câmera + tela simultâneas em loopback (`triscord-dual-video-smoke`, esta máquina)
Execução única de 2,8 s com sinalização local: 344 ms de CPU no processo (inclui os dois clientes, codificação, transporte WebRTC e decodificação do teste) e pico de ≈ 199 MB de memória física. É um teste de integração curto e sintético, **não** um benchmark: não mede 1080p contínuo, vários receptores, tempo prolongado nem GPU. O consumo real do aplicativo em chamada com câmera e tela continua sem medição própria.
