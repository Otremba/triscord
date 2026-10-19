# Arquitetura: interface web (WebView2) + núcleo C++

Proposta do Claude Code, 16/10/2026, para revisão do Codex e decisão do usuário. Nada foi implementado ainda.
Seções marcadas **[DECIDIR]** estão abertas. O Codex responde em "Revisão do Codex", no fim do arquivo.

## Objetivo e orçamento

- Interface com aparência e interação do Discord, escrita por nós (HTML/CSS/TS próprios) a partir das
  especificações extraídas com REA (`desktop/design-spec/`). Nada de código, CSS literal, fonte ou imagem do Discord.
- Núcleo C++ atual mantido: sinalização, voz, vídeo, tela, câmera, auth, hub, TURN, mídia de perfil.
- **[DECIDIR] Orçamento parado**: proposta de ≤ 250 MB somando o app e os processos do WebView2, CPU parada ~0.
  O limite antigo de ~120 MB não se sustenta com Chromium. Referências medidas: Qt atual ~90 MB, Discord 857–1.046 MB,
  Triscord Electron antigo 1.073 MB.

## Visão geral

```
triscord.exe (C++/Qt Core, 1 processo)                WebView2 runtime (Edge, já instalado no Windows)
├─ Núcleo (existente)                                 ├─ browser / GPU / utilitário
│  Signaling, VoiceService, ScreenService,            └─ renderer: a interface (TS + CSS)
│  CameraPublisher, AuthSession, HubApi, ...                    ▲        │
├─ AppState (novo): estado único da aplicação                    │ JSON   │ comandos
│  extraído do MainWindow                                       │ (eventos/patches)
├─ WebBridge (novo): protocolo tipado ◄──────────────────────────┘        │
│  PostWebMessageAsJson / WebMessageReceived  ◄──────────────────────────┘
├─ VideoSurface (novo): caminho de quadros de vídeo → interface   [DECIDIR, ver Vídeo]
└─ HostWindow (novo): QWindow nativa + controller WebView2 + native_frame.cpp (reaproveitado)
```

## Decisões propostas

1. **O núcleo é a fonte da verdade; a interface só desenha.**
   - Hoje o `MainWindow` (~1.800 linhas) mistura estado (salas, participantes, mudo, rejoin, servidores) com widgets.
     Esse estado sai para um `AppState` em C++, sem dependência de widgets e testável sozinho.
   - A interface recebe um retrato inicial e depois atualizações, e manda comandos (`joinRoom`, `setMuted`, `createServer`…).
     Nenhuma regra de negócio fica no JS.
2. **Rede só no C++.**
   - A interface não faz `fetch` para fora. A CSP bloqueia toda origem externa, exceto imagens de avatar/faixa servidas por um handler local.
   - Token de sessão, convites e credenciais TURN nunca chegam ao JS. Isso reduz o estrago de qualquer injeção na interface.
3. **Assets locais e offline.**
   - A interface vai empacotada com o app e é servida por `SetVirtualHostNameToFolderMapping("app.triscord", …)`.
   - Sem servidor HTTP local e sem CDN.
4. **Pilha web enxuta.**
   - TypeScript + **Preact** (~4 KB), ou só TS com componentes próprios **[DECIDIR]**. CSS próprio com variáveis
     geradas de `design-spec/tokens.json`. Build com esbuild.
   - Sem React completo nem bibliotecas de UI: cada KB e cada timer contam no orçamento.
5. **Protocolo versionado.**
   - Mensagens `{v, type, id?, payload}`. Os tipos ficam definidos uma vez (JSON Schema) e geram tipos TS + validação no C++.
   - Toda mensagem de entrada é validada no C++, porque a interface é tratada como não confiável.
6. **Janela.**
   - Qt continua dono do loop de eventos (Qt Core/Network/WebSockets/Multimedia já são usados pelo núcleo).
   - Uma `QWindow` nativa hospeda o controller do WebView2 e reaproveita `native_frame.cpp` (sem moldura, arrastar, encaixe).
   - Qt Widgets sai por fases; isso também devolve memória.
7. **Compilador.**
   - O projeto usa MinGW e o SDK do WebView2 é pensado para MSVC.
   - Plano: headers COM do SDK + `WebView2Loader.dll` carregada dinamicamente (`CreateCoreWebView2EnvironmentWithOptions`).
   - **Risco**: só confirmado no protótipo. Se falhar, a alternativa é compilar só a casca com MSVC/clang-cl.

## Vídeo — o ponto mais difícil [DECIDIR após medir]

A mídia continua em C++. Mostrar câmera e tela dentro da interface web exige levar os quadros até ela:

| Opção | Como | Prós | Contras |
|---|---|---|---|
| A. Janelas nativas sobrepostas | A interface informa os retângulos dos cartões; o C++ desenha o vídeo em HWNDs por cima (DirectComposition) | Sem cópia; desempenho igual ao atual | Menus, tooltips e cantos arredondados não ficam por cima do vídeo; sincronizar rolagem e animação |
| B. SharedBuffer do WebView2 | `PostSharedBufferToScript` com quadros I420/RGBA; WebGL/`VideoFrame` desenha no canvas | Tudo dentro da interface; fiel ao Discord | Uma cópia por quadro; 1080p60 ≈ 500 MB/s de memória, aceitável para 1 foco e caro para muitos |
| C. WebRTC dentro do navegador | Chromium decodifica tudo | Simples para a interface | Perde o núcleo C++ de mídia; consumo do Chromium em chamada |

Proposta: **B** para a grade (miniaturas ≤ 360p) e medir **B vs A** para o vídeo em foco (1080p). O protótipo mede CPU e memória dos dois.

## Testes (ganho grande da mudança)

- **Interface isolada:** Playwright no Chromium com uma ponte falsa (estados determinísticos), capturas de referência e
  diferença de pixels contra as capturas reais do Discord no mesmo tamanho e escala. É rápido e não abre janelas do app.
- **Ponta a ponta:** o app real com depuração remota habilitada só em build de desenvolvimento; Playwright conecta por CDP.
  Backend real local (Miniflare + Google falso, `tests/e2e/backend.mjs`, já pronto). Substitui o pywinauto.
- **Núcleo:** os testes atuais (CTest) continuam; `AppState` e `WebBridge` ganham testes próprios.
- **Orçamento como teste:** memória e CPU parados medidos automaticamente; falha se passar do limite.

## Fases

0. **Protótipo de medição**: casca + layout principal estático + um vídeo pelos caminhos A e B. Medir e decidir o orçamento.
1. `AppState` + `WebBridge` + moldura/trilho/lateral/painel da conta (login, servidores, salas).
2. Chamada: cartões, barra de controles, vídeo, transmissão.
3. Chat, modais (servidor, perfil, configurações), menus e popovers.
4. Remover Qt Widgets; empacotamento; medição final.

## Divisão de trabalho e não-conflito

| | Claude Code | Codex |
|---|---|---|
| Escreve em | `desktop/src`, `desktop/web` (nova), `desktop/tests` | `desktop/design-spec` (nova), `desktop/out/rea-codex-*`, `cloudflare*/` |
| Faz | casca, AppState, ponte, interface, testes, pacote, medições | especificações de tela via REA; mudanças de backend que a interface precisar; revisão desta arquitetura |

**Mudança de backend provável** (Codex): incluir `avatar_url` (e talvez a cor/tema de perfil) dos participantes nos
eventos de sala da sinalização, derivados da sessão. Hoje os outros participantes aparecem só como letra.

## Perguntas abertas para o Codex

1. Vê outro caminho de vídeo melhor que A/B? Algum risco no `PostSharedBufferToScript` com o runtime 155?
2. O protocolo deve mandar retrato completo + patches, ou só eventos? Algum padrão que facilite os testes do backend?
3. Que dados de perfil público dos participantes o hub pode entregar sem custo extra (D1/Durable Object)?
4. O formato de `design-spec/` proposto (Markdown + JSON por tela + `tokens.json`) serve para você gerar com REA?
5. Preact ou TS puro?
6. Algum risco de segurança na ponte (mensagens não confiáveis da interface) que você trataria diferente?

## Fase 0 — resultados (Claude Code, 16/10/2026)

**Portão 1 (casca + MinGW + assets + ponte): aprovado.**
- `src/webview_host.*` + `tools/webview_spike.cpp` (alvo `triscord-web-spike`, só no build de desenvolvimento):
  - compila e linka com o MinGW do projeto, usando os headers oficiais do SDK 1.0.4258.31 (`.toolchain/webview2`, nupkg SHA-256 `56f7f4b8…`);
  - sem WRL/WIL; os IIDs vêm das strings do próprio `WebView2.h`;
  - `WebView2Loader.dll` carregada só da pasta do executável.
- Segurança aplicada no host:
  - origem fixa `https://app.triscord/` (mapeamento de pasta com CORS negado);
  - navegação externa e novas janelas bloqueadas; todas as permissões negadas;
  - origem conferida em cada mensagem e entrada limitada a 64 KB;
  - DevTools, menus e diálogos padrão desligados fora do modo de desenvolvimento;
  - CSP no `index.html` com `connect-src`, `media-src`, `frame-src` e `object-src` em `'none'`;
  - renderer recarregado em `ProcessFailed`.
- Ida e volta comprovada: a interface manda `requestSnapshot`, o C++ responde com o retrato e a interface desenha.
  - Prova em `out/web-compare/webview2-preview.png`, via `CapturePreview` (de dentro do navegador).
  - O `PrintWindow` da janela captura preto: não serve para testar conteúdo do WebView2.
- Bug real achado no caminho e corrigido: o retrato chegava antes de o componente se inscrever no store (`useSession`), e a interface ficava vazia.

**Medição parada** (1264×892, interface da moldura desenhada, tema midnight, sem chamada; soma da casca e de todos os processos filhos do WebView2):

| | Memória privada | CPU parada |
|---|---|---|
| Casca WebView2, depois de assentar (≥ 40 s) | **~162 MB** (estável) | 0 ms em 3 de 4 janelas de 10 s; uma de 109 ms |
| Casca WebView2, primeiros 30 s | 124 → 230 MB | 250–656 ms / 10 s (inicialização do Chromium) |
| Cliente Qt atual | ~66–72 MB | 0 ms |
| Discord (medido antes) | ~766 MB | — |

- A memória física somada (330–390 MB) conta várias vezes as páginas compartilhadas entre processos e não é usada como métrica.
- Uma correção aplicada antes desta medição: só repassar ao WebView a visibilidade quando ela muda (evita um possível laço Qt↔WebView no `Expose`).
- **Ainda não medido:** vídeo (caminhos A/B), modais, GIF, minimizar e resize, ciclos de recarga. O orçamento continua decisão do usuário.

**Interface (`desktop/web`):**
- Preact + TS + esbuild (`app.js` ~31 KB).
- Tokens gerados pelo próprio Chromium a partir das declarações recuperadas (4.761 tokens; hex batendo com as medições antigas).
- Moldura (barra de título, trilho, lateral, painel da conta, cabeçalho, composer) com valores dos módulos CSS do Discord.
- Comparação por região contra `out/reference/discord-nav-client.png`: **0,4–5,4%** de pixels diferentes nas regiões comparáveis (`tools/compare.mjs`).

**Pendências desta fase:**
- vídeo A/B;
- fonte livre para distribuir (Noto Sans, segunda da pilha do Discord; a gg sans é só para comparação local);
- cor do indicador de status online;
- `AppState` + ponte real com o núcleo.

## Fase 0 — vídeo A/B (Claude Code, 16/10/2026)

Teste com `triscord-web-spike --video base|a|b|b-scaled --fps 30|60`:
- quadros sintéticos 1920×1080 BGRA, no mesmo layout de memória do `QImage` do núcleo;
- cartão 16:9 de ~856×481 na interface;
- CPU somada da árvore inteira (casca + processos do WebView2) em 20 s, depois de 20 s de assentamento.

| 1080p | CPU total (% de 1 núcleo) | Memória privada | Quadros |
|---|---|---|---|
| base 30 fps (só gerar) | 1,0% | 166 MB | — |
| **A 30 fps** (janela nativa `QRasterWindow` sobre o retângulo do cartão) | **2,8%** | **172 MB** | 1.362/1.363 desenhados |
| B 30 fps (SharedBuffer 1080p → `VideoFrame` → canvas 2D) | 31–37% | 497–499 MB | 1.362 confirmados, 0 descartados |
| B reduzido 30 fps (C++ reduz para o tamanho do cartão antes) | 14,0% | 471 MB | 0 descartados |
| base 60 fps | 1,6% | 169 MB | — |
| **A 60 fps** | **6,0%** | **169 MB** | 2.807/2.811 |
| B reduzido 60 fps (depois da correção abaixo) | — | — | 1.249 postados, 0 descartados |

**Decisão: caminho A** para câmera e tela (grade e foco). O B custa 5–13× mais CPU e +300 MB.
- Consequência do A: menus e tooltips não ficam por cima do vídeo.
- Mitigação planejada: a interface avisa quando um popover cruza um cartão, e o núcleo esconde ou recorta a janela; cantos arredondados via região da janela.
- Ainda não testado: rolagem e animação da grade com a janela acompanhando, e DPI ≠ 100%.

**Defeitos achados e corrigidos** no B (a proteção de memória funcionou, mas o vídeo congelava):
1. O C++ postava quadros antes de a página registrar o ouvinte: os 3 buffers ficavam presos para sempre.
   - Agora o vídeo só começa depois do `requestSnapshot`.
   - O host recupera qualquer buffer sem confirmação há mais de 1 s.
2. Página oculta ou coberta não recebe `requestAnimationFrame`: a interface devolve o buffer na hora quando `document.hidden`, ou em até 250 ms em qualquer caso.

O caminho B continua no código como transporte genérico de buffers (útil para miniaturas pequenas e capturas de tela), não para vídeo.

## Fase 1 — interface ligada ao núcleo real (Claude Code, 16/10/2026)

- **`src/core_session.*`**: primeira fatia do estado do app fora do `MainWindow`.
  - Cobre conta, servidores (hub real), salas e participantes (sinalização real), conexão, mudo e fone.
  - Envia retrato + deltas com revisão.
  - Não possui mídia: o `VoiceService` reage sozinho aos eventos de sinalização, como no cliente Qt.
- Validação de comandos no C++: lista de nomes permitidos, tipos conferidos, **campos extras rejeitados**, IDs que precisam existir no estado atual e nomes limitados a 32 caracteres.
- **`triscord-web`** (`tools/web_main.cpp`): núcleo real + `WebViewHost` + `web/dist`.
  - Usa os mesmos ganchos de ambiente do cliente Qt (perfil isolado, auth e hub locais, áudio sintético).
  - `--script`/`--probe` só com `--devtools`.
- **E2E `tests/e2e/run_web_e2e.py`: aprovado.**
  - Conta e servidor criados nos Workers reais locais; `triscord-web` logado.
  - Verificado na interface: servidor no trilho e no cabeçalho, nome da conta, sala criada pelo comando `createChannel`, `room-joined` do hub e Alice conectada na sala.
  - Defeitos achados e corrigidos pelo teste:
    1. o campo `name` de `createChannel` colidia com o discriminador `name` do comando (agora `channelName`);
    2. o servidor lembrado era conferido contra a lista antiga e se perdia na inicialização.
- Cliente Qt intacto: CTest 12/12, UI 53/53.

**Ainda não ligado:**
- tela de login web (hoje `triscord-web` usa a sessão já salva);
- botão "+" de canal (falta o modal);
- participantes sob o canal de voz;
- câmera e tela pelo caminho A;
- chat, convites e menus de áudio;
- TURN via `/ice` no `CoreSession`;
- fonte livre;
- cor do indicador online.

## Fase 2 — chamada completa no cliente novo (Claude Code, 16/10/2026)

**Núcleo (`CoreSession`):**
- participantes da sala, com mudo, fone, quem fala (`VoiceService::speakingChanged`), câmera e "AO VIVO";
- streams de câmera e tela vindos de `CameraPublisher`/`ScreenService`;
- comandos `setCamera`, `leaveVoice`, `listShareSources` (com miniaturas como evento), `startScreenShare` e `stopScreenShare`;
- `user-state-updated` e `force-muted` tratados;
- envio do estado real ao entrar: o hub admite todos silenciados, e sem isso todos apareciam com o microfone cortado — achado pelo teste.

**Vídeo, caminho A (`src/video_overlays.*`):**
- uma janela nativa por stream sobre o retângulo do cartão;
- cantos de 8 px por máscara;
- vídeo inteiro, sem cortes;
- pílula com o nome desenhada pela própria janela (o HTML ficaria por baixo);
- escondida quando o cartão sai da tela e enquanto um modal está aberto, porque a janela nativa cobriria o HTML.

**Interface:**
- participantes sob o canal: avatar de 24 px, nome de 14 px, ícones de 16 px, anel verde ao falar;
- palco preto com cartões 16:9 dimensionados pelo tamanho real do palco; a câmera substitui o cartão do dono, como no Discord;
- barra em cápsulas (`_f1ceac`): microfone preso à setinha, câmera e tela verdes quando ativas, "Desconectar" vermelho de 64×50;
- "Voz conectada" / "Vídeo conectado" no painel da conta;
- seletor de compartilhamento (SHARE.md: 960×746, abas, grade de 439×247, hover "Compartilhar tela").

**E2E `tests/e2e/run_web_call_e2e.py` (dois `triscord-web`, backend real local, áudio e câmera sintéticos): aprovado.**
- Na Alice: Alice e Bob sob a sala, Bob marcado com câmera, stream da câmera dele na grade e a janela nativa **desenhando 75 quadros** em ~6 s.
- No Bob: conectado e com câmera ligada.
- Prova visual em `out/web-call-e2e-report/alice-composited.png` (captura do WebView + imagem da janela nativa na posição do cartão).
- Defeitos achados e corrigidos neste ciclo:
  1. ícones de mudo falsos;
  2. câmera em cartão separado;
  3. grade vazando sobre o composer (tamanho fixo em vez do palco medido);
  4. janela nativa sobrando ao sair do cartão.
- Cliente Qt intacto: CTest 12/12, UI 53/53.

**Não verificado ou fora desta fase:**
- compartilhamento de tela de ponta a ponta: o seletor foi testado no Edge com a ponte falsa; começar a transmitir não foi exercitado no E2E, para não enviar a tela real do usuário nas capturas de teste;
- áudio real entre redes;
- DPI acima de 100%;
- rolagem da grade com as janelas nativas acompanhando;
- bloco de qualidade do seletor (usa 720p · 30fps, o padrão observado);
- foco e tela cheia de um cartão;
- volume por participante e menus de contexto;
- soundboard.

## Fase 3 — login e modais de servidor (Claude Code, 16/10/2026)

**Núcleo:**
- estado de autenticação no retrato (`signedOut` → `signingIn` → `needsNick` → `signedIn`);
- comandos `signIn` (o `GoogleAuthFlow` existente, sem widgets), `setNick`, `signOut`, `createServer` e `acceptInvite`;
- respostas assíncronas (`CoreSession::reply`), para os erros aparecerem no campo do modal;
- os erros de convite são os textos reais do `JOIN_GUILD`.

**Interface:**
- login com a caixa de auth do Discord (módulo `__921c5`: 480 px, padding 32, raio 8, título semibold) e a paleta pré-login medida no LOGIN.md;
- "Entrar com Google" no lugar de e-mail/senha/QR, que não têm função no Triscord;
- tela de apelido, que é do Triscord (o Discord não tem equivalente);
- modal "Criar seu servidor" (início, personalizar, entrar), com os valores observados e recuperados.

**E2E `tests/e2e/run_web_auth_e2e.py`: aprovado.** De um perfil vazio, só com cliques na interface:
- "Entrar com Google" → Google falso → worker de auth real → tela de apelido (sugestão `web-auth-alice` a partir do e-mail) → conectado como Alice;
- modal → "Criar o meu" → nome pré-preenchido "Servidor de Alice" → "Criar" → servidor no trilho;
- "Entrar em um servidor" com texto inválido → "Insira um link de convite ou um código de convite válido." no campo;
- convite real do Bob → servidor do Bob aberto e modal fechado.

**Defeitos achados e corrigidos pelo teste:**
1. Envio com valor antigo: o formulário lia o estado do componente antes da atualização; agora lê o campo.
2. Apelido sugerido não aparecia: chegava depois de a tela ser montada.

O cliente Qt também tem um erro de texto: "Bem-vindo de volta!" e um subtítulo inventado, contra o "Boas-vindas de volta!" observado. Ainda não corrigido.

**Regressão:** CTest 12/12, UI 53/53, os três E2E web anteriores aprovados.

**Lacunas (sem evidência, não implementadas):**
- **(resolvido na Fase 4)** **modal "Criar canal" e modal de convite do Discord:** não estão no cache, porque nunca foram abertos. Precisam de captura no Discord do usuário. Abrir o modal de convite **gera um link de convite real** no servidor dele.
- Enquanto isso:
  - o "+" da categoria ainda não faz nada no cliente web (criar uma sala exige o nome, e o modal não existe; o comando `createChannel` do núcleo já está pronto e testado);
  - o botão de convite do cabeçalho copia o código pelo núcleo, sem modal.
- Arte de fundo e logotipo do login: imagens proprietárias; substituídas pelo degradê das cores medidas.

## Fase 4 — modais "Criar canal" e convite (Claude Code, 16/10/2026)

**Evidência (com autorização do usuário):** abri os dois modais no Discord dele, no "Servidor de camargo", e fechei sem criar canal nem enviar nada. O de convite gerou um link no servidor dele, como avisado; não cliquei em nenhum "Convidar". O auto mode bloqueou um clique no campo do nome; por isso não há captura com o campo preenchido.
- Capturas em `out/claude-observations/`: `discord-create-channel-text.png`, `-voice.png`, `discord-invite-modal.png`, `-copied.png` (1280x900, 96 DPI, tema escuro). As do convite mostram a lista de amigos do usuário: são só locais e não devem ser publicadas.
- Cache relido. Chunks: `f8adfb328d505533.js` (criar canal, `renderCreateChannelModal`) e `940ef764bff92620.js` (`InstantInviteModal`).
- Modal genérico do design system: módulos 189213/224640/20742/430993/364840/696208, CSS `__8a031`.
- Campo de cópia: 747007/416052/109802, CSS `_fffc15`. Também `__62141` (criar canal), `__67dba` (convite) e `__5a838` (rótulo de campo).
- Regras em `out/rea-claude-20261016/css-rules/modals-channel-invite.css` (173 regras, URL e SHA-256 por arquivo). Textos pt-BR pelas chaves do locale.

**Núcleo:**
- `copyServerInvite` saiu. Entraram `createInvite {serverId}` (resposta `{code}`; 403 → "Só quem criou o servidor pode convidar pessoas.") e `copyInvite {code}`.
- `copyInvite` só copia códigos que o próprio núcleo criou nesta sessão; o renderer não escolhe o texto do clipboard.
- O host copia com o clipboard nativo, ou para `TRISCORD_CLIPBOARD_FILE` nos testes, para não sobrescrever o clipboard do usuário.

**Interface:**
- `Modal.tsx`: a casca do design system (480 px, padding 24/8/16, seções 16/24/8, título heading-lg/semibold, subtítulo text-md em `--text-subtle`, fechar no slot absoluto, ações dividindo a largura com 8 px). Será a base dos próximos modais.
- "Criar canal" (pelo "+" da categoria):
  - título, "em {categoria}", "Tipo de canal", "Nome do canal" com ícone e placeholder "novo-canal", "Cancelar" + "Criar canal" (desativado sem nome);
  - erro do núcleo no rodapé, como o `renderError` do Discord;
  - só a opção "Voz", porque as salas do Triscord são de voz. Texto, Fórum, "Canal privado" e o botão de emoji ficaram de fora por não terem função no Triscord.
- Convite (pelo botão do cabeçalho):
  - usa a variante sem amigos que existe no código do Discord, porque o Triscord não tem lista de amigos: texto "Compartilhe este link com outros para conceder acesso ao seu servidor!", campo com o código e "Copiar" (verde "Copiado" por 1 s);
  - abaixo, "Seu link de convite nunca irá expirar.": os convites do hub não têm validade nem limite de usos;
  - o campo mostra o código puro: o Triscord não tem domínio de convite, e "Entrar em um servidor" aceita o código;
  - o checkbox "nunca expirar" e as configurações do link ficaram de fora.
- Valores inferidos ou medidos (não estão no CSS recuperado):
  - opção de rádio com padding 8, círculo de 20 px e 12 px até o texto; título regular branco; ponto de 8 px;
  - botões 40 px, 16 px medium;
  - ícone do campo em `--icon-strong`;
  - −3 px depois do grupo de rádio (medido: 17 px até "Nome do canal");
  - verde do "Copiado" = `--status-positive-background`, visto no zoom. O vermelho de erro é inferido.

**Comparação** (`web/tools/compare-modals.mjs`, Edge com a fonte gg sans local; relatório em `out/web-compare-modals/`), por região:
- "Criar canal": cabeçalho 0,02%, rótulo 1,36%, opção Voz 3,03%, campo do nome 2,17%, ações 0%. Na captura, o rádio estava sob o mouse, o campo estava focado e tinha o botão de emoji.
- Convite: geometria do campo igual. O texto difere (link `discord.gg` × código) e o "Copiar" estava sob o mouse.

**E2E `run_web_auth_e2e.py` estendido: aprovado (11 verificações).** Depois de entrar no servidor do Bob, Alice volta ao próprio servidor e:
- abre o convite ("Convidar amigos para Servidor de Alice");
- copia: o arquivo de teste recebe o código mostrado;
- o Bob resgata esse código no hub e passa a ver "Servidor de Alice", o que prova que o código é real;
- abre "Criar canal" ("em Canais de Voz", botão desativado sem nome), cria "Sala do Modal", e a sala aparece na lista.

**Regressão e entrega:**
- CTest 12/12 (UI 53/53); E2E web de sala e de chamada aprovados;
- `portable.ps1` concluído; `C:\Users\camargo\Desktop\triscord.exe` atualizado (hash conferido);
- ocioso, 25 s de espera e janela de 10 s:
  - cliente web na tela de login: 179 MB privados, 31 ms de CPU;
  - cliente Qt: 21 MB, 0 ms.

**Lacunas:**
- estado do "Criar canal" com nome digitado (sem captura);
- cor exata do erro no campo de cópia;
- modal "Editar link de convite" (não aberto; o Triscord não tem essas opções).

## Fase 5 — fonte, animações, chat e voz (Claude Code, 17/10/2026)

**Fonte:**
- O cliente web nunca carregava a gg sans e caía em Arial. O `tools/build.mjs` agora copia `assets/fonts-local/ggsans-*.ttf` (local, ignorado pelo git) para `dist/fonts` com um `fonts.css`.
- Sem os arquivos, cai em Noto Sans.
- `desktop/web/dist/` entrou no `.gitignore`, para a fonte proprietária nunca ser versionada.
- O CMake copiava `web/dist` só quando o executável era religado. Agora `triscord-web-assets` copia a cada build.

**Ferramentas de captura** (em `out/claude-observations/`):
- `record-frames.ps1`: grava a janela com PrintWindow a ~80 quadros/s e dispara cliques, teclas e movimentos em coordenadas da janela, conferindo antes se ela está em primeiro plano.
- `analyze-frames.cjs` e `montage.cjs`: linha do tempo das mudanças e folhas de contato.
- Gravações em `motion/`: modal, trilho, canal, categoria, entrada/saída de voz, chamada, controles, câmera, compartilhamento.
- `tools/rea-css-motion.cjs` lista todas as `@keyframes` e transições do CSS recuperado (906 arquivos, 276 keyframes, 1281 regras).

**Animações do bundle** (molas react-spring viraram curvas CSS `linear()` geradas por `tools/spring-easing.mjs`):

| Elemento | Mola | Comportamento |
|---|---|---|
| Fundo do modal | módulo 943320, tensão 1000 / atrito 48 | opacidade, cor `--background-scrim` |
| Modal | módulo 150591 | entra com a mesma mola após 64 ms; sai com opacidade 0 e escala 0,9 (1200 / 80) |
| Tooltip | módulo 900002, 2400 / 52 | opacidade e escala 0,95 → 1 |

A filmagem do Discord confere: o fundo escurece em ~70 ms e o modal termina ~160 ms depois.

**Tooltip** (CSS `_c36707`):
- Componente reutilizável; o do servidor é o GuildTooltip: semibold 16 px, 12 px do ícone.
- Medido: 36 px de altura e seta no centro.
- Está no trilho, no chat, no painel e nos controles.

**Chat da sala**, ponta a ponta:
- Núcleo:
  - histórico ao entrar, mensagens novas, exclusão, reações e limite de taxa;
  - comandos `sendChatMessage`, `deleteChatMessage` e `toggleReaction`, validados contra os limites do hub (2000 caracteres, 6 reações);
  - "própria" e "minha reação" comparam com o id que o hub usa (o da conta, quando autenticado). O E2E pegou esse defeito.
- Interface (`ChatPanel.tsx`):
  - painel de 450 px (CHAT.md);
  - mensagem cozy com CSS recuperado (`_c19a55`, `__5126c`): avatar de 40 px, conteúdo a 72 px, grupo novo 17 px abaixo;
  - agrupamento por autor, mesmo dia e até 7 minutos (regra do bundle);
  - horários "Hoje às", "Ontem às" e "dd/MM/aaaa HH:mm" (formatos moment do bundle);
  - separador de data (`__908e2`), reações (`_f8896c`) e barra de hover com 3 reações rápidas e "Adicionar reação".
- Abre por "Mostrar chat" no cabeçalho ou por "Abrir chat" na linha do canal (ícones de hover, CSS `_c69b6d`).
- O campo decorativo no rodapé da página de voz foi removido: o Discord não tem campo de mensagem nessa página.

**Voz** (filmado sozinho no "Servidor de camargo", com autorização; estado do usuário restaurado ao final):
- Painel:
  - ícone de sinal (ConnectionFineIcon) e "Vídeo conectado" com câmera;
  - câmera riscada quando desligada (VideoSlashIcon);
  - faixa da transmissão com o título da janela e botão de parar;
  - nome de usuário no lugar do status ao passar o mouse;
  - tooltips com os textos do locale.
- Canal conectado: alto-falante e tempo de chamada em `--text-feedback-positive`, e linha "Convidar para voz" (dono do servidor).
- Selo verde de voz (ou de tela) no ícone do servidor.
- Chamada:
  - controles em dois grupos e convite à esquerda;
  - cabeçalho e controles somem após 2 s parado (`timeout: 2e3` do bundle), com fade de 200 ms;
  - o primeiro card começa 64 px abaixo do topo, como medido.
- Tela de antes de entrar: "Ninguém está em voz" e "Entrar na chamada de voz".
- Selo "AO VIVO" na cor medida (`--badge-notification-background`).
- Ícones novos na tabela compartilhada com o Qt: VideoSlash, ConnectionFine e WindowLaunch.

**Testes e entrega:**
- E2E novo `run_web_chat_e2e.py`, com duas instâncias reais: aprovado (6 verificações).
- Os outros três E2E web aprovados; CTest 12/12 (UI 53/53).
- `portable.ps1` concluído; `triscord.exe` da Área de Trabalho atualizado (hash conferido).
- Ocioso (login, perfil limpo): web 192 MB privados e 16 ms de CPU em 10 s (a gg sans soma ~12 MB); Qt 21 MB e 0 ms.

**Lacunas e desvios:**
- **Sem função no Triscord:** "Editar canal", "Definir um status do canal", atividades, supressão de ruído, seta da câmera (menu de dispositivo), "Mais opções", pop-out e tela cheia.
- **Soundboard:** existe no hub, mas ainda não tem interface web.
- **Excluir mensagem:** espera o menu de contexto, que nunca foi aberto, então não está no cache.
- **Voz ao trocar de servidor:** o núcleo desconecta (uma conexão de sinalização por servidor); o Discord mantém a voz.
- **Clique no canal de voz:** o Discord entra na voz sem trocar a página e abre a chamada no segundo clique; o Triscord, que não tem canais de texto, entra e já mostra a chamada.
- **Inferidos:**
  - degradê da tela de antes de entrar (cores medidas nos cantos);
  - fonte do tempo de chamada;
  - cor do selo do servidor: medida `--icon-voice-speaking`, enquanto a regra recuperada diz `--status-positive`.

## Fase 6 — menus de contexto e exclusão de mensagem (Claude Code, 17/10/2026)

**Captura** (com autorização; só abrir, passar o mouse e fechar com Esc): no Discord do usuário, botão direito no ícone do "Servidor de camargo", no canal de voz "Geral", na própria mensagem "oi" do `#geral` e no próprio nome de usuário. Gravações em `out/claude-observations/motion/ctx-*`:
- os menus abrem e fecham num quadro, sem animação;
- abrem no ponto do clique e são deslocados para caber na janela;
- o do servidor e o da mensagem têm 220 px; o do canal se ajusta ao conteúdo;
- itens com ícone têm 36 px e sem ícone 34 px;
- no hover o fundo fica claro, e vermelho translúcido no item de excluir.

**REA** (cache relido depois da captura):
- CSS do menu `_c1e9c4` (`out/rea-claude-20261016/css-rules/menu_c1e9c4.css`), renderizador no módulo 980707;
- modal de exclusão (chunk `b_0ec277134df5e9c9`, CSS `_fd14e0`) com os textos "Excluir mensagem", "Deseja mesmo excluir essa mensagem?", "Cancelar"/"Excluir" e a dica do Shift (IxY7E6);
- ícones CopyIcon (624479) e TrashIcon (241326), já na tabela compartilhada com o Qt.

**Implementado:**
- `ContextMenu.tsx`: um menu por vez; posição, Esc, clique fora, rolagem e perda de foco fecham; teclado com setas e Enter; submenu; linha de reações rápidas; item de perigo.
- **Servidor:** "Convidar para o servidor" (dono) e "Criar canal".
- **Canal de voz:** "Convidar para voz" (dono), "Abrir chat" (sala atual) e "Criar canal de voz".
- **Mensagem** (clique direito ou botão "Mais" da barra de hover):
  - 4 reações rápidas (as quatro primeiras das seis do hub) e "Adicionar reação" (submenu com as seis);
  - "Copiar texto": comando `copyMessageText` do núcleo, que copia o texto da mensagem escolhida, nunca um texto vindo da interface;
  - "Excluir mensagem" (só nas próprias), que abre `DeleteMessageModal` com prévia, dica e "Excluir" vermelho; Shift+clique exclui direto, como a dica descreve.
- Os demais itens do Discord não têm função no Triscord e ficaram de fora: lidas, notificações, configurações, perfil por servidor, categorias, eventos, mover, fixar, links, editar, responder, encaminhar, tópicos, lembretes, apps, falar e excluir canal.
- **Menu de usuário:** não implementado. O do próprio usuário só tem itens sem função no Triscord (perfil, mencionar, perfil por servidor, apps, moderador), e o de outra pessoa na chamada não pôde ser observado sem outra pessoa.

**Comparação:** o menu da mensagem coincide em largura, alturas, separadores, hover e item de perigo (`out/web-compare-modals/menu-message-*.png`). Diferem a arte dos emojis (Twemoji no Discord) e os itens omitidos.

**Testes e entrega:**
- `run_web_chat_e2e.py` estendido (10 verificações, aprovado): menu da mensagem com 4 reações e os 3 itens; "Copiar texto" grava o texto (em arquivo de teste); "Excluir mensagem" pede confirmação com o texto do Discord, e a mensagem some para Alice e para Bob.
- Os outros três E2E web aprovados; CTest 12/12 (UI 53/53).
- `portable.ps1` concluído; `triscord.exe` atualizado (hash conferido).
- Ocioso: web 189 MB privados e 31 ms de CPU em 10 s; Qt 21 MB e 0 ms.

## Fase 7 — Configurações de usuário (Claude Code, 17/10/2026)

**Captura** (com autorização; só navegação, nada salvo): no Discord do usuário, filmei a abertura e o fechamento e passei por "Conta", "Notificações", "Voz e vídeo" e "Aparência". A navegação foi rolada até "Sair".
- Capturas em `out/claude-observations/motion/settings-*`. A de "Conta" mostra o nome de usuário e o e-mail mascarado e fica só local.
- O cliente tem o Vencord: a seção "Vencord Settings" e as opções de desenvolvedor não são do Discord original e foram ignoradas.
- **Abertura e fechamento:** as mesmas molas do modal (fundo e depois o painel), já implementadas na `ModalLayer`.
- **Layout medido** (área cliente 1264×892):
  - painel a 40 px das bordas;
  - navegação de 252 px (`--background-base-lower`) e conteúdo em `--background-base-low`;
  - item selecionado em `--background-mod-normal`;
  - cabeçalho de 49 px e coluna de 696 px centralizada sem contar a barra de rolagem;
  - seletores de 340×40, controle deslizante com trilho de 4 px e alça de 16 px;
  - interruptor de 48×24 e quadrados de tema de 48 px.

**REA:**
- Chunk das configurações `f_000076`.
- Textos do locale: "Editar perfis", "Microfone", "Alto-falante", "Volume do Microfone/Alto-falante", "Supressão de ruído", "Câmera", "Tema", "Temas padrão", "Informações da conta", "Nome de usuário", "Editar", "Concluído", "Sair".
- Nomes dos temas pelo código: **Claro** (light), **Cinza** (dark, o que o usuário usa), **Escuro** (darker) e **Ônix** (midnight).
- Ícones UserIcon, PaintPaletteIcon, DoorExitIcon e CircleCheckIcon, adicionados à tabela compartilhada com o Qt.
- O extrator de tokens agora gera os quatro temas.
- **Lacuna:** o CSS da casca de navegação não está no cache (o Discord usa um sistema de layout novo nessa tela); a geometria é medida.

**Núcleo:**
- `session.settings`: listas de dispositivos, escolha atual, volumes, supressão de ruído e tema.
- Comandos `setSetting {key, value}` (validação por chave e faixa; dispositivo só da lista ou o padrão) e `requestDevices`.
- Mesmas chaves do QSettings do cliente Qt. Aplica dispositivos, ganhos (`sliderToGain`), supressão de ruído e a saída do áudio da transmissão.
- Antes, o cliente web não aplicava nada disso e usava sempre os padrões.

**Interface (`Settings.tsx`):**
- Navegação com perfil, "Buscar" (filtra a navegação), "Conta", "Experiência › Voz e vídeo" (subseções Voz e Câmera, cujo marcador acompanha a rolagem), "Aparência" e "Sair" em vermelho.
- **Conta:** "Nome de usuário" com "Editar", que abre um modal e grava pelo `setNick`.
- **Voz e vídeo:** microfone, alto-falante, os dois volumes, supressão de ruído (liga/desliga) e câmera.
- **Aparência:** os quatro temas, aplicados na hora e guardados no núcleo.
- **Sair:** abre uma confirmação. Ela é inferida, porque o modal de saída do Discord não foi aberto; usa os textos do locale "Sair" e "Você tem certeza de que deseja sair?".
- **Fora:** Notificações (o notificador do Qt exige Qt Widgets; falta um notificador sem Widgets no cliente web), teste do microfone, perfis de entrada, sensibilidade, cancelamento de eco e as demais categorias.

**Medição e verificação:**
- Comparação com a captura: coluna (x 410), seletor (y 243) e controle deslizante (centro em y 347) coincidem com o Discord.
- No modo de áudio real, o núcleo lista 1 microfone e 2 saídas e nenhuma câmera. O Windows não tem câmera física, só a OBS Virtual Camera (DirectShow), que o Media Foundation do Qt não enxerga; o resultado está correto.
- E2E novo `run_web_settings_e2e.py` (aprovado, 6 verificações):
  - desligar a supressão de ruído e pôr o alto-falante em 150 chegam ao núcleo;
  - "Claro" aplica os tokens claros;
  - "Editar" troca o nome no worker de auth e no painel;
  - "Sair" pede confirmação e volta ao login;
  - depois de reiniciar, as escolhas continuam.
- Os outros quatro E2E web aprovados; CTest 12/12 (UI 53/53).
- `portable.ps1` concluído; `triscord.exe` atualizado (hash conferido).
- Ocioso: web 189 MB privados e 0 ms de CPU em 10 s; Qt 21 MB e 0 ms.

## Fase 8 — soundboard (Claude Code, 17/10/2026)

**Incidente na captura (corrigido):** durante a pausa por limite de uso, o usuário entrou no canal de voz "Geral" do **gogó de ferro** (a chamada já durava 3h25). O roteiro de captura era para o Servidor de camargo.
- Meu primeiro clique, que devia reativar o áudio, **desativou o áudio da sessão real do usuário**; o segundo (abrir o soundboard) não teve efeito, porque o botão fica desativado com o áudio desligado.
- Detectei pelas gravações e devolvi o estado anterior (áudio ligado, microfone mutado), conferido em captura.
- Nenhum som foi tocado e ninguém mais estava no canal. Parei de interagir com o Discord nessa sessão.
- A captura nova de hover e animação ficou para outra autorização. A evidência visual é a de 15/10 (`reference/discord-sb-3-open.png`, SOUNDBOARD.md).

**Trabalho paralelo encontrado:** outra frente já tinha criado `SoundPlayer` (reprodução sem Widgets, catálogo embutido verificado por SHA-256), os comandos `playSound`/`previewSound`/`stopSoundPreview`, o evento `soundboard-played`, `Soundboard.tsx` e `run_web_soundboard_e2e.py`. Mantive tudo isso e completei.

**REA** (cache): CSS do bloco `__9be63`, do seletor `__09f65`, do cabeçalho `__0856d`, do trilho `_a1e0e0` e das seções `__61424` (`out/rea-claude-20261016/css-rules/soundboard*.css`). Código do bloco: módulo 817232, com prévia (ícone secundário), `PlayIcon` no centro e favorito. O código do seletor usa linhas de 48 px.

**Alterado:**
- **Visual alinhado ao CSS recuperado:**
  - painel em `--background-base-low` com `--shadow-border` + `--shadow-high`;
  - busca e trilho em `--background-base-lower`; foco de 2 px da marca;
  - cabeçalho de seção fixo no topo, com hover em `--interactive-text-active`;
  - blocos 148×40 em `--background-mod-subtle`, raio 8, nome semibold `--text-strong` em até 2 linhas, borda só no hover;
  - no hover, sobreposição `--background-surface-highest` a 80% com a prévia à esquerda e o `PlayIcon` no centro; o favorito fica de fora (sem função);
  - tocando, borda `--status-positive-background`; ao clicar, desce 2 px.
- **Ícone `PlayIcon`** (782134) adicionado à tabela compartilhada.
- **"Volume dos efeitos sonoros"** (seção "Painel de efeitos sonoros" de Voz e vídeo, observada): `setSetting soundboardVolume` (0–100), mesma chave QSettings do Qt, lida pelo `SoundPlayer` a cada som.

**Testes e entrega:**
- Soundboard E2E 9/9 (prévia isolada, transmissão ao outro participante, áudio desligado silencia, ID inválido rejeitado, limite de taxa, Esc e foco).
- Configurações E2E 7/7 (nova verificação do volume dos efeitos sonoros).
- Também aprovados: perfil 20/20, menus de áudio 8/8, conta 22/22, sala, chamada, login e chat. CTest 12/12 (UI 53/53).
- `portable.ps1` concluído; `triscord.exe` atualizado (hash conferido).
- Ocioso: web 195 MB privados e 16 ms de CPU em 10 s; Qt 21 MB e 0 ms.

**Lacunas:**
- Animação de abertura do painel e estado de hover do Discord não filmados nesta rodada (incidente acima). A sobreposição vem do CSS, não de captura.
- Seção "Utilizados com frequência", "Sons do Discord", outros servidores, Nitro, "Adicionar som", dica de atalho e botão de volume ao lado da busca: sem função no Triscord.

## Fase 9 — notificações sem Qt Widgets (Claude Code, 17/10/2026)

**Contexto:** trabalho em paralelo com o Codex, que nesta hora mede desempenho. As notificações estavam pendentes nas duas listas (FRONTEND_WEB_PROGRESSO_20261017.md).

**Arquitetura:**
- **`NotificationPolicy`** (`src/notification_policy.*`, em `triscord_core`, só Qt Core): a regra que já existia no Qt, extraída sem mudança. Avisa de menções ao seu nome no chat da sala e de quem entra na sua sala, só com o app em segundo plano, no máximo uma de cada a cada 3 s, nunca das próprias mensagens.
- **`DesktopNotifications`** (Qt Widgets) agora delega a ela; a mesma API mantém os testes de UI válidos.
- **`WinNotifier`** (`src/win_notifier.*`, só no `triscord-web`): aviso nativo do Windows via `Shell_NotifyIconW` (o balão aparece como toast no Windows 10/11), com uma janela só de mensagens. Clicar no aviso ou no ícone traz a janela.
- **Núcleo:** `setWindowActive` (o host informa o primeiro plano), evento `user-joined` e menções em `new-chat-message`. O sinal `notify(title, body, toast, flash)` segue as configurações. O host mostra o aviso e pisca o botão da barra de tarefas (`QWindow::alert`).
- **Configurações:** chaves `desktopNotifications` (a mesma do Qt) e `taskbarAlert`. Nova página **Notificações › Visão geral** com os dois interruptores observados no Discord (motion/settings-notifications.png).
  - A descrição do primeiro é do Triscord (inferida), porque a do Discord remete a notificações por servidor, que não existem aqui; a do segundo é a observada.
  - "Notifique-me quando..." ficou de fora (amigos, eventos e reações não existem no Triscord).
- **Variáveis de teste:** `TRISCORD_TEST_BACKGROUND` e `TRISCORD_NOTIFY_FILE` (o aviso vai para um arquivo, nada aparece na tela).
- **Build:** `scripts/build.ps1 -BuildDir out/build-claude` cria uma árvore de build separada, para dois agentes não compilarem no mesmo Ninja.

**Testes e entrega:**
- E2E novo `run_web_notifications_e2e.py` (duas instâncias, aprovado, 5 verificações):
  - entrada do Bob gera aviso e alerta;
  - menção gera aviso com o remetente e o texto;
  - mensagem sem menção não gera nada;
  - com as notificações desligadas, só o alerta da barra de tarefas.
- Regressão: CTest 12/12 (UI 53/53); configurações 7/7, chat 11/11, chamada 8/8, soundboard 9/9, login 12/12.
- `portable.ps1` concluído; `triscord.exe` atualizado (hash conferido).
- Ocioso: web 194 MB privados e 31 ms de CPU em 10 s; Qt 21 MB e 0 ms.
- **Não verificado:** a exibição real do toast na tela (o teste usa o arquivo, para não abrir avisos sem você saber).

## Fase 10 — PiP e janela destacada (Claude Code, 17/10/2026)

Pedido: assumir "janela destacada/PiP" da lista do Codex sem colidir com o trabalho de desempenho dele. Antes de começar, a coordenação registrava que não havia build ou E2E do Codex em andamento. Os arquivos alterados foram anunciados em TRISCORD_COORDINATION.md.

### PiP dentro do app: evidência e por que não foi implementado

**Observado no cache (REA, `decoded/f_00000a` e blocos citados):**
- **Quando abre (módulo da store com `Vt`, que chama a ação 31728 OPEN):** o PiP de vídeo abre só com você em chamada **e** olhando outro canal (`getChannelId() !== voiceChannelId`). Também exige vídeo na chamada (câmera ligada e não desativada localmente, ou transmissão). Fecha com a janela pop-out aberta ou com uma camada aberta, como as Configurações.
- **Janela (módulos 197808/205297/155819, 6341f):**
  - largura padrão 320, mínima 200, máxima 960, arredondada a múltiplos de 40 (806931);
  - margens: 80 em cima, à esquerda e à direita, e 132 embaixo;
  - encaixe no quadrante de `ponteiro + 200·velocidade` ao soltar;
  - o arrasto começa depois de 3 px e segue o ponteiro com mola tension 80 / friction 8; a volta ao canto usa a mola padrão 40/7 (conversão "origami" do Animated);
  - alça de redimensionar de 20 px a −7 px, no canto interno;
  - transição de largura `.2s ease-in-out`.
- **Conteúdo (806911/271195/e4cb9a):**
  - 16:9, raio 8, fundo `--primary-800` e sombra `elevation-high`;
  - gradiente de controles e cabeçalho com seta (477155) e nome do canal, que leva de volta à chamada;
  - nome do participante embaixo à esquerda;
  - botões embaixo à direita: Desconectar, Parar de assistir/transmitir;
  - inatividade de 1,8 s;
  - escolha de quem aparece pela VideoSpeakerStore (94247): participante selecionado, depois a última transmissão, depois quem falou mais recentemente com câmera, por fim você.

**Por que não se aplica ao Triscord:**
- todo canal do Triscord é de voz, e clicar nele entra na chamada (`selectChannel` → `joinVoice`);
- trocar de servidor sai da voz (`selectServer` → `leaveVoice`).

Por isso, a condição "em chamada, olhando outro canal" nunca ocorre aqui, e o PiP seria código sem caminho de uso. Um rascunho chegou a ser escrito: quadro reduzido pelo caminho B, com buffers compartilhados até um canvas. Ele foi **removido** antes do build. Se o Triscord ganhar canais de texto, a evidência acima basta para fazer o PiP.

### Janela destacada (implementada)

**Observado:**
- **Botão (módulos 540462 `renderBottomRight` e 128286):** fica na bandeja inferior direita, antes de "Tela cheia". O texto é "Nova Janela" (JzWezz). Com a janela aberta, vira "Voltar para o Discord" (7Dwcnj), e o ícone WindowLaunch (811893) gira −180° (`popIn_c7da74`). Só aparece em modo vídeo.
- **Janela:** `CHANNEL_CALL_POPOUT`, com tamanho padrão de 854×480.
- **Na janela destacada:** "Mostrar sempre" (ZVGHwP, ícone 788120) e "Remover do topo" (YdyDM9, ícone 609731), que chamam `setAlwaysOnTop` (619344).
- **Na janela principal:** sem "Tela cheia". O conteúdo da chamada dá lugar à mensagem J5bXZU, "Você abriu uma janela separada para esta reprodução". Ela fica sobre uma camada `--opacity-black-60` (`root_e605a1`), com título text-md/semibold branco centralizado (`header_c6e099`, 200749 sem arte). Cabeçalho e controles continuam.
- **Fechamento:** sair da chamada fecha a janela (`componentDidUpdate` do 540462).

**Adaptações e inferências:**
- o texto vira "Voltar para o Triscord";
- "modo vídeo" é inferido como "a chamada tem algum vídeo" (`session.streams`). Com a janela aberta, o botão continua visível para voltar;
- trocar de sala também fecha a janela, porque o canal deixa de ser a chamada;
- título da janela "Triscord", com a barra de título web igual à da principal. A aparência da barra do pop-out no Discord **não foi observada**;
- "Mostrar sempre" não persiste: no Discord o estado é da janela aberta, e a persistência não foi comprovada.

**Arquitetura:**
- **Núcleo:**
  - estado `callPopout` e `callPopoutOnTop`;
  - comandos `setCallPopout` (só em chamada) e `setCallPopoutOnTop` (só com a janela aberta);
  - sinal `callPopout(open, onTop)`;
  - `closeCallPopout()` para o host;
  - `patch()` fecha a janela quando `connectedChannelId` muda de fato;
  - abrir a janela tira a principal da tela cheia.
- **Host (`web_main.cpp`):**
  - segunda `QWindow` de 854×480 com o próprio `WebViewHost`, na mesma pasta de dados e no mesmo processo de navegador; a página abre em `?popout=call` (`setStartQuery`, que aceita só `[A-Za-z0-9=&]` e não sai da origem);
  - a janela tem os próprios `VideoOverlays` (caminho A), que recebem os quadros e os rótulos já em curso;
  - deltas, eventos e respostas tardias vão às duas páginas; as respostas imediatas voltam à página que perguntou;
  - `fromPopout` faz os comandos `window` e `videoSurface` da página pop-out agirem na janela pop-out;
  - "Mostrar sempre" usa `Qt::WindowStaysOnTopHint`;
  - um `CloseWatcher` trata o fechamento pelo sistema e o fechamento da janela principal;
  - a destruição fica para o turno seguinte, porque pode ocorrer dentro do callback da própria página.
- **Ponte:** a página pop-out usa o prefixo `p` nos IDs de pedido, porque recebe também as respostas tardias da principal.
- **Web:**
  - `App` em modo pop-out mostra só a barra de título, a chamada e os menus e cartões que ela abre;
  - `ChannelView popout` mostra o canal da chamada;
  - `CallView` traz a bandeja nova e a mensagem.
- **Correção de um bug que já existia, achado pela captura:** um bloco que muda de lugar sem mudar de tamanho deixava a janela de vídeo nativa na posição antiga. No pop-out, o vídeo do Bob caía sobre o cartão da Alice. Agora o `CallView` pede um novo relato dos retângulos (`tri-layout-changed`) quando a composição da grade muda.

### Testes e entrega

- **E2E novo `run_web_popout_e2e.py`:** duas instâncias, câmera sintética do Bob; aprovado com 10 verificações:
  - sozinho, sem vídeo: sem "Nova Janela";
  - com vídeo: "Nova Janela" ao lado de "Tela cheia";
  - a janela abre com a própria página;
  - o vídeo nativo do pop-out pinta os quadros do Bob;
  - a principal mostra a mensagem e zero blocos; só "Voltar para o Triscord", sem "Tela cheia";
  - `WS_EX_TOPMOST` lido do Windows depois de "Mostrar sempre", e ausente antes;
  - voltar fecha a janela e a grade e o vídeo nativo voltam;
  - o `WM_CLOSE` real fecha a janela;
  - sair da chamada fecha a janela.

  Capturas locais em `out/web-popout-e2e-report/`, revisadas.
- **Regressão:** CTest 12/12 em `out/build-claude`. E2E web aprovados, sem falhas:
  - chamada; visão da chamada (29 verificações), que cobre a tela cheia e a ocultação do Codex; chat, rodado de novo com `PYTHONIOENCODING=utf-8`, porque a primeira falha era o console cp1252 sem conseguir imprimir 👍;
  - configurações, soundboard, notificações, login, participante (21), áudio por participante (29), conta (22), perfil (20) e menus de áudio (8).
- **Entrega:** `portable.ps1` concluído, com as verificações do pacote aprovadas. `triscord.exe` da Área de Trabalho atualizado: SHA-256 `E45EE3F19CEB85B6FD739C98CD1908EB84BBC14C7ACFE208DE898D6A85494CA1`, hash conferido.
- **Ocioso (10 s):**
  - web: 194–203 MB privados e 15,6–31,2 ms de CPU, depois de 40 s de espera; com 25 s de espera, uma medida deu 187,5 ms, ainda na fase de assentamento;
  - Qt: 20,7 MB e 0 ms.
- **Não verificado:** DPI acima de 100% e vários monitores; a aparência real da janela pop-out do Discord, que não foi capturada.

### Fase 10b — "Tela cheia" dentro da janela destacada (Claude Code, 17/10/2026)

**Evidência:** no módulo 540462, `canFullscreen` vale `modo vídeo && inCall && !(popoutOpen && !inPopout)`. Ou seja, o Discord esconde "Tela cheia" na janela principal com a chamada destacada e oferece o botão **dentro** da janela destacada. Lá, o botão (423562) recebe `guestWindow`, a própria janela pop-out. A ordem na bandeja é: "Mostrar sempre", o botão de pop-out e "Tela cheia".

**Implementação:**
- **Núcleo:** campo `callPopoutFullscreen`, separado de `callFullscreen` (que é da janela principal). `setCallPopoutFullscreenState` é chamado pelo host, e fechar a janela destacada zera o campo.
- **Host:** o mesmo comando `setCallFullscreen` vindo da página pop-out (`fromPopout`) põe em tela cheia a **janela pop-out**. O estado anterior, normal ou maximizado, é guardado e restaurado. `windowStateChanged` da janela pop-out informa o núcleo, e o Esc sobre o vídeo nativo dela sai da tela cheia.
- **Web:** o `App` escolhe a tela cheia da própria janela. No pop-out, ela esconde a barra de título e mostra "Pressione Esc para sair da tela cheia", igual à principal. O `CallView` mostra "Tela cheia" / "Sair da tela cheia" no pop-out e continua escondendo o botão na janela principal enquanto a chamada está destacada.
- **Teste:** o host ganhou `--popout-script` e `--popout-probe`, só com `--devtools` (o host recusa scripts sem isso). Eles rodam scripts na página pop-out a cada abertura, para o E2E clicar no botão real dela.

**Testes e entrega:**
- **`run_web_popout_e2e.py`: 14/14.** O botão "Tela cheia" clicado na página pop-out deixa a janela pop-out com 1920 px de largura interna, maior que a principal. O layout fica sem barra de título, com o aviso e com "Sair da tela cheia". O Esc volta a janela para 854 px, e a janela principal nunca entra em tela cheia.
- **Regressão:** CTest 12/12; E2E de visão da chamada 29, chamada 10, chat 11, configurações 7, participante 21, áudio por participante 29, soundboard 9 e conta 22, todos aprovados.
- **Entrega:** `portable.ps1` concluído; `triscord.exe` da Área de Trabalho atualizado, SHA-256 `C60CC63EBF8675E354B800975E08FD99E8787994199FF783DE4C46AF02B099C6`, hash conferido.
- **Ocioso (10 s, depois de 40 s):** web 197–226 MB e 0–62,5 ms em três medidas, com variação entre execuções; a mudança não roda sem chamada. Qt 21,3 MB e 0 ms.
- **Não verificado:** DPI acima de 100% e vários monitores. A aparência real da janela pop-out do Discord continua sem captura.

### Fase 11 — menu do participante sobre o vídeo nativo (Claude Code, 17/10/2026)

**Evidência:** no Discord, o cartão da chamada abre o menu do usuário pelo clique direito (`onContextMenuParticipant: this.handleContextMenu`, módulo 540462). No Triscord, os cartões com vídeo são cobertos por uma janela nativa (caminho A). A página não recebe o clique, e por isso o menu só existia pela lateral.

**Implementação:**
- `VideoOverlayWindow` transforma o clique direito (na soltura, como o Chromium no Windows) em `VideoOverlays::contextMenuRequested(streamId, ponto)`, com o ponto na janela-pai em CSS px.
- O host envia o evento `videoContextMenu {streamId, x, y}` à página dona das janelas: a principal, ou a página pop-out para as janelas dela.
- O `CallView` abre ali o menu do dono do vídeo, com perfil, áudio e o grupo de moderação quando você é o dono da sala. O cartão do perfil se ancora no bloco (`data-stream`). A barra do cartão (DOM) também abre o mesmo menu.
- **Correção de um bug que já existia:** o `ContextMenuHost` não suspendia as janelas nativas, ao contrário de modais e popovers. Um menu aberto sobre um vídeo, inclusive pela lateral, ficava escondido atrás dele. Agora o menu suspende o vídeo nativo enquanto está aberto, e o vídeo volta ao fechar.
- **Limite (resolvido na Fase 11b):** todos os vídeos sumiam enquanto qualquer menu estava aberto. Agora só a área do menu é recortada.

**Testes:**
- **E2E novo `run_web_video_menu_e2e.py`: 5/5.** É um clique direito real (`WM_RBUTTONDOWN`/`WM_RBUTTONUP` enviados à janela de vídeo nativa da Alice, sem mover o mouse). Ele abre o menu do Bob com "Ver perfil", "Áudio do participante", "Silenciar voz na sala" e "Desconectar". O vídeo nativo sai da frente com o menu aberto e volta depois, e a barra do cartão abre o mesmo menu.
- **Regressão:** CTest 12/12; moderação 35, visão da chamada 29, janela destacada 14, chat 11, participante 21, áudio por participante 29 e chamada 10, todos aprovados.

**Entrega:**
- `portable.ps1` concluído; `triscord.exe` da Área de Trabalho atualizado, SHA-256 `AF478E486414444C4FCF532D8581D0E3CE786DFD514AD0629373431E38AFADE0`, hash conferido;
- ocioso (10 s, depois de 40 s): web 200–201 MB e 0–15,6 ms; Qt 20,5 MB e 0 ms.

**Não verificado:** o clique direito dentro da janela pop-out (o caminho existe, mas o E2E cobre a janela principal); DPI acima de 100%.

### Fase 11b — vídeo visível sob o menu, só a área do menu recortada (Claude Code, 17/10/2026)

Na Fase 11, o menu escondia todos os vídeos nativos enquanto estava aberto. No Discord, o vídeo continua sob o menu. Agora só a área que o menu cobre é recortada.

**Implementação:**
- **Página:** `video.ts` ganhou `setOccluders(chave, retângulos)`, que reúne as camadas flutuantes (no máximo 8 retângulos) e envia `videoOccluders`. O `ContextMenuHost` informa os retângulos de cada `.tri-menu` aberto, inclusive o submenu. Ele usa um `MutationObserver` e limpa os retângulos ao fechar. Os modais continuam com `suspendOverlays`.
- **Núcleo:** valida `videoOccluders`: lista de até 8 retângulos com exatamente x, y, largura e altura inteiros, dentro de ±10000. Emite o sinal `videoOccluders`, que o host aplica à camada de vídeo da página que enviou (principal ou pop-out, via `fromPopout`).
- **`VideoOverlayWindow::applyMask`:** a máscara arredondada (8 px) menos os retângulos que cruzam a janela, em coordenadas locais. A página aparece ali, e o vídeo em volta continua sendo desenhado. Se a região ficar vazia, a janela se esconde, porque no Qt máscara vazia quer dizer "sem máscara". O log de diagnóstico ganhou `occluded=N`.
- **Limite:** a sombra do menu não aparece por cima do vídeo, porque o recorte é exatamente o retângulo do menu.

**Testes:**
- **`run_web_video_menu_e2e.py`: 5/5.** Com o menu aberto, a janela nativa continua visível (`visible=1 occluded=1`); ao fechar, `occluded=0`. A captura real da janela da Alice (`PrintWindow` com `PW_RENDERFULLCONTENT`, que funciona mesmo com a janela do Bob por cima) foi revisada: o menu do Bob aparece no ponto do clique, e o vídeo segue visível em volta.
- **Regressão:** CTest 12/12; moderação 35, visão da chamada 29, janela destacada 14, chat 11, participante 21, áudio por participante 29 e chamada 10.

**Entrega:**
- `portable.ps1` concluído; `triscord.exe` atualizado, SHA-256 `1B78D3EC0D9300FDB2C6BA831B996A77933602035CD728557D4AABB6DB3FA25F`, hash conferido;
- ocioso: web 197–204 MB e 0–15,6 ms; Qt 20,4 MB e 0 ms.

### Fase 12 — opções de transmissão (Claude Code, 17/10/2026)

**Evidência:** `out/claude-observations/SHARE.md`, observado no Discord. O rodapé do seletor mostra "Jogos" (16 px, negrito) sobre "Vídeo mais suave · 720p · 30fps" (12 px), o seletor SD/HD (110×40) e a engrenagem (40×40). A engrenagem abre "Modo de transmissão" (245 px, alinhado à direita, base 10 px acima), com:
- Jogos (720p, 30fps) e Compartilhamento de tela (Fonte, 5fps);
- Personalizada;
- "Silenciar áudio da transmissão";
- "Avançado ›".

O cliente Qt já implementava isso (`src/share_picker.cpp`). A REA `REA_QUALIDADE_20261016.md` registra o default 720p/30.

**Implementação:**
- **Rodapé no seletor web,** com o menu do modo. As escolhas ficam salvas nas **mesmas chaves do Qt** (`shareMode`, `shareResolution`, `shareSystemAudio`) por `setSetting` (`shareMode`, `shareHd`, `shareAudio`), e as duas interfaces compartilham a preferência.
- **O núcleo inicia a transmissão** com `screenPreset`: SD = 720p e HD = 1080p; Jogos a 30 fps (60 em HD); Compartilhamento de tela a 15 fps; áudio do sistema conforme "Silenciar áudio da transmissão". Antes, o web sempre usava 720p/30 sem áudio.
- **Inferido, como no Qt:** o mapeamento SD/HD e os FPS (o Triscord não tem 5 fps nem "Fonte"). O HD não exige Nitro aqui. O áudio do sistema começa desligado, igual ao Qt e ao contrário do default do Discord (`soundshareEnabled=true`): não está provado que a captura exclui o som da própria chamada.
- **Fora do escopo:** "Personalizada", "Avançado", a aba Dispositivos e a faixa Nitro.
- **Para quem assiste:** "Volume da transmissão" (0–200) e "Silenciar transmissão" estendem o `setPeerAudio` do Codex (`streamVolume`, `streamMuted`), separados da voz. Eles aparecem no diálogo de áudio do participante e no menu do participante (caixa de seleção), só quando a pessoa está transmitindo. O núcleo aplica tudo ao `ScreenService` e reaplica quando a transmissão começa.
- **`ModalLayer`:** o Esc não fecha mais o modal enquanto houver um menu aberto dentro dele (o menu do modo fecha primeiro).
- **Ajuste visual:** "Silenciar áudio da transmissão" ficava 1 px maior que o espaço no menu de 245 px. A folga da caixa nessa linha passou para 6 px, para manter uma linha só, como na observação. Conferido no navegador com fixtures, sem conteúdo desta máquina.

**Testes:**
- **E2E novo `run_web_stream_options_e2e.py`: 12/12.** A Alice transmite a própria janela do Triscord, sem áudio do sistema e sem gravar o conteúdo no relatório. O teste confere:
  - defaults "Jogos / 720p · 30fps / SD" e HD com "1080p · 60fps";
  - o menu com as duas linhas de qualidade, "Texto mais claro · 1080p · 15fps" e as escolhas salvas;
  - o Esc fecha só o menu do modo;
  - o Bob recebe 1920×1080;
  - valores inválidos são recusados;
  - volume 40% e silenciar ficam no núcleo, separados da voz; o menu marcado e o diálogo também.
- **Regressão:** CTest 12/12; configurações 7, áudio por participante 29, moderação 35, janela destacada 14, menu sobre o vídeo 5, chamada 10 e chat 11.
- **Estabilidade:** a visão da chamada falhou uma vez dentro da sequência longa. O primeiro passo, a tela cheia nativa, não foi observado no tempo do teste, e o resto caiu em cascata. Rodado sozinho logo depois, deu 29/29. Fica como achado de estabilidade do harness ou do foco de janela, sem correção nesta rodada.

**Entrega:**
- `portable.ps1` concluído; `triscord.exe` atualizado, SHA-256 `F6F0C4E53992F6EE3C66E1EEB4F79876BBF8E9038F9078FC8A75EF372698C94B`, hash conferido;
- ocioso: web 198–204 MB e 0–15,6 ms; Qt 21,4 MB e 0 ms.

**Não verificado:** os FPS reais enviados (o E2E confere a resolução); o efeito audível do volume da transmissão (estado e chamada ao `ScreenService` verificados, a saída de som não); o áudio do sistema transmitido.

### Fase 12b — selos "AO VIVO" e de qualidade no cartão da transmissão (Claude Code, 17/10/2026)

**Evidência:** `SHARE.md` registra o cartão da transmissão com "AO VIVO" (62×16) a 8 px do canto superior direito. Com o mouse em cima, aparece antes dele a pílula cinza "720P 30FPS", com P maiúsculo. A pílula de 16 px, raio 4, texto branco de 11 px em negrito, vermelho `#d22d39` e cinza `#4f505a` vem do Qt (`ParticipantPane::drawBadge`), que foi medido. Só se conhece o FPS da própria transmissão; nas remotas, só a altura.

**Cabeçalho:** as pílulas aparecem só na visão ampliada, feita na Fase 13.

**Implementação:**
- O vídeo é uma janela nativa por cima do cartão, então os selos são desenhados nela, como a pílula do nome. Os novos `VideoOverlays::setLive(stream, live, fps, altura)` e o sinal `CoreSession::videoLive` são emitidos junto do rótulo.
- **Texto da qualidade:** a altura do quadro e o FPS. Na transmissão **própria**, o núcleo informa a resolução e o FPS configurados (`shareResolution`, `shareFps`), porque a prévia local chega reduzida a 360p. Isso foi achado pelo E2E: antes, aparecia "360P 60FPS".
- **Hover:** passou a reagir também ao `MouseMove`. Antes dependia só do `Enter`, que se perde quando a janela aparece sob um cursor parado. O E2E encontrou isso: a pílula não aparecia.
- A janela pop-out recebe os mesmos selos.

**Testes:**
- **`run_web_stream_options_e2e.py`: 15/15** (12 anteriores e 3 novos). Pelo log, o cartão remoto mostra "AO VIVO" e, no hover, "1080P | AO VIVO"; o próprio mostra "1080P 60FPS | AO VIVO". O teste também move o **cursor real** sobre o cartão do Bob, com a janela dele no topo por um instante, e devolve o cursor ao lugar. Na imagem capturada há pixels do selo vermelho e da pílula cinza antes dele, e a captura foi revisada. Um `WM_MOUSEMOVE` postado não serve, porque o Qt confere o cursor real.
- **Regressão:** CTest 12/12; chamada 10, janela destacada 14, menu sobre o vídeo 5, moderação 35 e áudio por participante 29.
- **Instabilidade aberta, a visão da chamada:** falhou duas vezes quando rodou logo depois de outros processos de teste (CTest ou outros E2E). A janela entra em tela cheia e sai sozinha no mesmo instante, sem comando de saída no log. Isolada, passou três vezes, 29/29. Fica como suspeita de foco ou ativação de processos anteriores, a investigar.

**Entrega:**
- `triscord.exe` atualizado, SHA-256 `A33965E82D0E61128DD1F821B95DE5EE0828E18DFB28F9029DD97B51124B6120`, hash conferido;
- ocioso: web 195–200 MB e 0 ms; Qt 21,3 MB e 0 ms.

### Fase 13 — visão ampliada da transmissão (Claude Code, 17/10/2026)

**Evidência:** `SHARE.md`, observado no Discord (`vid-6`, `vid-7` e `vid-9`, área cliente de 1264×892). Clicar no cartão amplia. O cabeçalho mostra "Geral • (avatar) Tela de camargo" e, à direita, antes do chat, as pílulas "720p 30FPS" (p minúsculo) e "AO VIVO". A faixa traz todos os cartões, com nomes sempre visíveis e o ícone de tela sobre a miniatura da transmissão. Um botão de 62×32 recolhe a faixa; recolhida, a própria câmera vira prévia de 162×92. Esc não saiu da visão. Medidas do Qt `ParticipantPane`, ajustadas ao Discord:
- palco na área menos 119 px;
- miniaturas de 195×112, intervalo de 8 px, topo 201 px acima do fim da área;
- botão no topo da faixa + 8, ou 188 px acima do fim quando recolhido;
- prévia a 16/20 px do canto.

**Implementação:**
- **Foco no `ChannelView`.** O foco (`CallFocus`: cartão em foco e faixa aberta) mora lá, e o cabeçalho ganha o ponto, o avatar de 24 px, "Tela de X" (ou o nome) e as pílulas. A qualidade é a altura do quadro; na transmissão própria, a resolução e o FPS configurados.
- **Layout no `CallView`,** absoluto sobre a área: do fim do cabeçalho até 50 px acima do fim da página, exatamente como no Discord (80–842 em 1264×892, contra 81–842 medidos).
- **Cliques:**
  - um cartão de vídeo (bloco ou janela nativa, via novo evento `videoClick`) amplia;
  - o palco volta à grade;
  - uma miniatura move o foco.
- **Papel da janela nativa** (`videoRole`: grade, palco ou faixa):
  - no palco, sem selos (as pílulas vão no cabeçalho);
  - na faixa, pílula de nome de 28 px, "AO VIVO" sem qualidade e o ícone de tela centralizado. O `discord_icons.cpp` (só Qt Gui) entra no executável web.
- **O botão da faixa** fica sobre uma miniatura, então é recortado das janelas nativas (`setOccluders('film-toggle')`).

**Limites e adaptações:**
- Cada vídeo nativo é uma janela só, então a cópia do cartão ampliado na faixa é um marcador em DOM com o ícone de tela e o nome, sem imagem. O Discord mostra a imagem nos dois lugares.
- O recorte do botão é retangular: os cantos arredondados mostram o fundo da página, não o vídeo.
- **Fora do escopo:** o botão de zoom (sem visualizador por trás no web). Na faixa, a câmera da pessoa ampliada também aparece pelo mesmo motivo de janela única.
- A janela pop-out tem a própria visão ampliada.

**Testes:**
- **E2E novo `run_web_focus_e2e.py`: 11/11.**
  - Um clique real (`WM_LBUTTONDOWN`/`WM_LBUTTONUP` na janela nativa da transmissão) amplia.
  - Cabeçalho "Tela de Bob", com "720p" e "AO VIVO".
  - Palco com a largura da área, centralizado acima da reserva de 119 px.
  - Três miniaturas de 195×112, a cada 203 px, topo 201 px acima do fim.
  - Botão a +8; o botão é recortado da janela nativa sob ele (`occluded=1`).
  - Papéis nativos: palco e faixa.
  - Recolhida: prévia de 162×92 a 16/20 px.
  - Miniatura da câmera muda o foco ("Alice", sem pílulas), e o palco volta à grade.
  - Captura real revisada.
- No navegador, com a nova fixture `stream`, a geometria bate com o Discord: faixa em y=641, igual à medida.
- **Regressão:** CTest 12/12; opções de transmissão 15, janela destacada 14, menu sobre o vídeo 5, moderação 35, chamada 10, chat 11, áudio por participante 29, participante 21 e visão da chamada 29, todos aprovados.

**Entrega:**
- `triscord.exe` atualizado, SHA-256 `67690A5256FA63FBEA23C33C658636507C21A9CBBE4E2F848DD108DC18EE7503`, hash conferido;
- ocioso: web 200–205 MB e 0 ms; Qt 21,5 MB e 0 ms.

### Fase 13b — comparação com o Discord real (Claude Code, 17/10/2026)

Entrei sozinho em voz, transmiti uma janela neutra e capturei:
- a visão ampliada (ativa, ociosa e com a faixa recolhida);
- a pop-out (ociosa e com controles);
- a janela principal com a pop-out aberta;
- o PiP dentro do app, ao olhar um canal de texto.

O Discord foi restaurado depois. Os detalhes e as folhas lado a lado, só locais, estão em `out/claude-observations/SHARE.md` (seção de 17/10) e `reference-20261017/`.

Iguais: o aviso da janela principal, a bandeja da pop-out (alfinete, voltar, tela cheia), os 854×480, a geometria da faixa e do palco, e o cabeçalho com as pílulas.

**Diferenças a corrigir:**
1. As pílulas do cabeçalho formam uma cápsula única no Discord, sem espaço.
2. Na inatividade, o Discord esconde os nomes (palco e faixa), a lupa e o botão de recolher.
3. A pop-out do Discord herda o foco (visão ampliada) da principal.
4. A barra da pop-out do Discord tem 24 px, só com os botões, e o título da janela é o nome do canal.
5. A janela principal web ainda tem a moldura nativa.

Uma medida (topo da faixa: 660 contra 641) precisa ser repetida antes de mudar a constante.

### Fase 13c — diferenças corrigidas a partir da observação de 17/10 (Claude Code)

Correções das diferenças 1 a 4 da Fase 13b:
1. **Cápsula única:** "720p 30FPS" e "AO VIVO" ficam juntas, sem espaço. A metade cinza tem cantos arredondados só à esquerda (4 px) e a vermelha só à direita.
2. **Inatividade:**
   - o botão de recolher some (opacidade 0, sem receber clique) e deixa de recortar as janelas nativas;
   - os nomes das pílulas da página somem, e as pílulas sem ícone desaparecem;
   - as janelas nativas deixam de desenhar a pílula do nome (comando `videoIdle`).

   Ficam "AO VIVO" e os ícones, como no Discord.
3. **Foco compartilhado pelo núcleo:** `session.callFocus` e o comando `setCallFocus`, limpo quando a chamada muda. A pop-out abre no cartão que estava em foco, e ao voltar a principal continua ampliada, como observado.
4. **Pop-out sem moldura do sistema** (`Qt::FramelessWindowHint`), com o título da janela = nome do canal. A barra web tem 24 px e só os botões (24×24, 4 px entre eles). Arrastar a barra move a janela, e as bordas de 4 px e os cantos de 6 px redimensionam (`window` com `move` e `resize-*`, que o host executa com `startSystemMove`/`startSystemResize`). Duplo clique maximiza.

**Achados da captura, também corrigidos:**
- **A janela nativa do palco cobria o topo das miniaturas.** A faixa flutua sobre a parte de baixo da área do palco, como no Discord, mas as bordas pretas da janela nativa pintavam por cima. Agora a faixa e o botão são recortados só da janela do palco, com o novo `videoStageOccluders`.
- **Posição vertical da faixa, medida hoje:** topo a 182 px do fim da área na principal (antes 201, de um build anterior do Discord) e a 141 px na pop-out de 854×480. O botão recolhido fica a 170 e 129 px. O centro do palco já batia nas duas janelas. As medidas valem para esses dois tamanhos.

**Testes:**
- Visão ampliada 13/13: inclui a cápsula (junção 0 px, raios `4px 0 0 4px` e `0 4px 4px 0`) e a inatividade (botão invisível e inerte, nomes ocultos, nativo `idle=1`).
- Janela destacada 17/17 (contagem corrigida na retomada): inclui a janela sem moldura de 854×480 com o título da sala, a barra de 24 px só com 3 botões, a pop-out abrindo no foco da principal e a volta ainda ampliada.
- CTest 12/12; opções de transmissão 15, menu sobre o vídeo 5, moderação 35, chamada 10, chat 11, áudio por participante 29, participante 21, configurações 7 e visão da chamada 29.
- Captura da pop-out revisada: faixa em y=289 a 400, como no Discord.

**Entrega:**
- `triscord.exe` atualizado, SHA-256 `4998F752CE3E0355283408F8AA401D6326E9D89D45FC69F9A02404D7B8557F34`;
- ocioso: web 203–207 MB e 15,6–31,2 ms; Qt 20,4 MB e 0 ms.

**Na conclusão desta fase:** a diferença 5 ainda estava pendente; foi implementada pelo Claude na rodada seguinte e fechada na Fase 13d.

### Fase 13d — janela principal sem moldura e pacote web correto (retomada Codex)

O último pedido ao Claude era retirar a moldura nativa da janela principal, com mover e redimensionar. Ele implementou `Qt::FramelessWindowHint`, a barra web de 32 px, bordas de 4 px/cantos de 6 px e barra disponível também no login/carregamento. O arrasto espera movimento de 3 px para não competir com duplo clique. A maximização da janela principal guarda a geometria normal e usa a área útil do monitor: esse caminho evitou o Windows remaximizar a janela ao sair da tela cheia. Pop-out mantém seu estado próprio.

**Evidência herdada e conferida:** o último teste físico de moldura no registro Claude (18/10/2026 01:59:27 UTC) passou nas cinco verificações: sem WS_CAPTION/WS_THICKFRAME, mover, redimensionar, maximizar e restaurar exatamente. O arquivo `out/claude-verify-frame.log` é de uma tentativa anterior que falhou; não representa o resultado final. A regressão posterior do Claude passou em CTest 12/12, visão ampliada 13 e janela destacada 17, além dos outros E2E. A contagem anterior de 18 da janela destacada estava errada. A captura `out/web-focus-e2e-report/focused-view.png` foi revisada nesta retomada: só a barra própria, sem a barra nativa duplicada.

**Problema de entrega encontrado:** o `portable.ps1` usado pelo Claude compila e embala `triscord-native.exe` (Qt Widgets), não o cliente que ele estava testando. Portanto, os registros antigos de “Desktop atualizado” comprovam a cópia do pacote Qt, e não a entrega da UI web. O hash C858C157… anterior a esta retomada corresponde a esse fluxo antigo.

**Correção:** `scripts/portable-web.ps1`, opção CMake `TRISCORD_BUILD_WEB_CLIENT`, CLI de teste compilada apenas em desenvolvimento, NSIS com entry point explícito e `tests/verify_web_release.py`. O novo pacote é `out/triscord-web.exe`; manifestos e hashes ficam em `out/portable-web-package.json`. Inclui interface/fontes/loader e licenças; exige Runtime WebView2 no Windows. Staging único por execução, sem apagar instalações ou pastas de outros builds. O empacotador Qt anterior foi preservado.

**Verificação da distribuição:** ajuda identifica C++/WebView2; 14 opções de desenvolvimento ausentes e rejeitadas; um único app no payload; assets/loader/licenças presentes; processo renderer WebView2 efetivamente iniciado; janela principal sem moldura e captura do login revisada. O lançador NSIS deve retornar sucesso e todos os arquivos extraídos devem ter o mesmo SHA-256 do staging. Perfis de teste isolados, sem login real e sem hardware de áudio/câmera. O verificador resolve o caminho após a extração, para contemplar a virtualização do Codex/MSIX para LocalCache, e só encerra os processos de sua própria instância.

**Limites:** DPI 125/150%, múltiplos monitores, Snap/atalhos do Windows e arrasto entre monitores ainda requerem QA. Não atribuir a esta validação a fidelidade de todos esses estados. As medidas ociosas 204,9 MB e 0–15,6 ms/10 s no registro Claude são históricas do build de desenvolvimento e não uma nova medição do pacote final.

### Fase 13d — janela principal sem moldura do sistema (Claude Code, 17/10/2026)

Diferença 5 da Fase 13b: a janela principal web tinha a moldura do Windows e, por baixo, a barra web. Agora ela é como a do Discord: só a barra de título da página.

**Implementação:**
- **Janela principal sem moldura** (`Qt::FramelessWindowHint`).
- **Mover:** arrastar a barra de 32 px envia `window` com `move` (`startSystemMove`) só depois de 3 px com o botão pressionado, para o duplo clique não ser confundido com arrasto. Arrastar uma janela maximizada devolve o tamanho normal sob o cursor, como no Windows.
- **Redimensionar:** bordas de 4 px e cantos de 6 px (`ResizeEdges`, `resize-*`, `startSystemResize`), fora da tela cheia.
- **Maximizar por geometria própria:** a área de trabalho, com a barra de tarefas visível, e o duplo clique na barra restaura. O log de diagnóstico mostrou que o Windows maximiza sozinho, de novo, uma janela sem moldura depois de um ciclo de tela cheia, e o teste da visão da chamada falhava em "normal again". Por isso a maximização não usa o estado do Qt. A saída da tela cheia volta à geometria anterior.
- **Login e carregamento** ganharam uma barra transparente só com os botões, que também move e redimensiona; sem ela, a janela sem moldura não teria como ser movida ou fechada nessas telas. **Inferido:** a barra pré-login do Discord não foi observada.
- A pop-out usa o mesmo arrasto com limiar.

**Testes:**
- **E2E novo `run_web_frame_e2e.py`: 5/5,** com cursor real por alguns segundos e a janela no topo:
  - sem `WS_CAPTION` nem `WS_THICKFRAME`, com a área cliente igual à janela;
  - arrastar a barra move 120×60 (2 px de atraso do limiar);
  - arrastar a borda direita aumenta 80 px;
  - o duplo clique maximiza para a área de trabalho `[0,0,1920,1032]` e restaura exatamente.
- **Regressão:** CTest 12/12; visão da chamada 29 (tela cheia e maximizar), login 12, janela destacada 17, visão ampliada 13, opções de transmissão 15, menu sobre o vídeo 5, moderação 35, chamada 10, chat 11, áudio por participante 29, participante 21, configurações 7, soundboard 9, notificações 5, conta 22, perfil 20 e menus de áudio 8. Captura da principal revisada.

**Entrega:**
- **Errata do Claude, achada pelo Codex:** o `scripts/portable.ps1` empacota o cliente **Qt Widgets** (`triscord-native.exe`). Os hashes de `triscord.exe` que registrei nas Fases 9 a 13d eram do cliente Qt, e não da interface web testada; o último, `C858C157…`, ficou como backup em `out/desktop-backups/`. A entrega web real é do `scripts/portable-web.ps1`, criado pelo Codex: a Área de Trabalho tem o cliente WebView2, SHA-256 `B0D942A1D314F142EA4A1FBD2F512F7484AC05697019A8447AD68681E5AF2505`, que já inclui esta fase. Ver `ENTREGA_WEB_20261017.md`.
- ocioso (`out/build-claude`): web 205 MB e 0–15,6 ms; Qt 22 MB e 0 ms.

**Não verificado:** encaixe nas bordas da tela (Aero Snap) pelo arrasto, DPI acima de 100% e vários monitores.


### Fase 14 — seletor de transmissão, servidores e animação dos popouts (Claude Code, 18/10/2026)

Pedidos do usuário, com uma captura comparando o seletor do Discord e o do Triscord:
- seletor de transmissão: o contorno de hover saía cortado, os monitores apareciam como "Monitor — \\.\DISPLAY1" e faltava a terceira aba, "Dispositivos";
- não dava para excluir servidores;
- abrir outro servidor tirava o usuário da chamada;
- fechar a criação de servidor no meio criava o servidor do mesmo jeito;
- animações mais fluidas.

**Seletor de transmissão**
- **Nomes:** monitores agora são "Tela 1", "Tela 2", na ordem do Windows (SHARE.md, como no cliente Qt). O nome vem do núcleo (`shareSourceName`) e também é usado na linha da transmissão do painel de voz.
- **Contorno:** o hover tem contorno de 2 px a 2 px de distância, e a grade rola com `overflow: hidden auto`, que cortava esse contorno. A grade ganhou 4 px de folga dos dois lados (`margin: 0 -4px; padding: 16px 4px`).
- **Legenda:** alinhada à esquerda da miniatura, como na captura do Discord, e cortada com reticências.
- **Aba "Dispositivos"** (VideoIcon; SHARE.md: dispositivos de captura com o botão "Transmitir"):
  - lista as câmeras das configurações;
  - escolher uma transmite essa câmera como a transmissão de tela do usuário;
  - `DeviceShare` (`src/device_share.*`): `CameraService` capta, `CameraEncoder` codifica numa thread de mídia com o preset escolhido no seletor (SD/HD, Jogos/Compartilhamento de tela), e os quadros saem pela sala de transmissão com `ScreenService::startExternal`/`sendFrame`;
  - `ScreenCall::startExternal` passou a aceitar quadros externos também no modo nativo;
  - pedido de quadro-chave, parar, sair da chamada e erros seguem o caminho da tela;
  - a prévia local chega em `scr:$local`.
- **Inferido:** o bloco preto com o ícone e o texto "Nenhum dispositivo de captura encontrado.". A prévia de dispositivo do Discord nunca foi observada, porque esta máquina não tem câmera.

**Excluir e sair de servidor**
- **Hub (`cloudflare/src/worker.js`):**
  - `DELETE /servers/:id`: só o dono; apaga convites, membros e o servidor num lote;
  - `POST /servers/:id/leave`: membros; o dono recebe 409;
  - o handshake do socket já exige membro, então ninguém entra de novo;
  - `tests/control.test.mjs` cobre 403 para quem não é dono, 409, sair, 403 depois de sair, excluir, linhas apagadas, 404 ao repetir e handshake 403.
- **Núcleo:**
  - `HubApi::deleteServer` / `leaveServer` e os comandos `deleteServer` / `leaveServer`;
  - se a chamada estava nesse servidor, sai dela;
  - se ele estava aberto, volta ao grupo e recarrega a lista.
- **Interface:**
  - o menu do servidor termina com "Sair do servidor" (vermelho, J2TBi3) para membros e "Excluir servidor" para o dono;
  - **desvio:** o Discord deixa a exclusão nas configurações do servidor, que o Triscord não tem.
- **Modais (`ServerRemovalModal`)**, textos do locale pt-BR no cache:
  - título `Excluir "nome"` (us7mC1);
  - "Deseja mesmo excluir **nome**? Esta ação é irreversível." (Zuo+Vd);
  - campo "Insira o nome do servidor" (abprOC), com o erro "Você não digitou o nome do servidor corretamente" (c2/DS/);
  - `Sair de "nome"` (1GX6P/), com "Deseja mesmo sair de **nome**? Você não poderá entrar neste servidor até ser convidado(a) novamente." (ZEXC0r).
- **Inferido:** o layout do modal de exclusão (módulo 310482, carregado sob demanda e ausente do cache). Ele usa o modal do design system, o mesmo de "Excluir mensagem".

**Outro servidor sem sair da chamada**
- **Causa:** havia uma só conexão de sinalização, apontada para o servidor visível, e trocar de servidor desligava a voz.
- **Agora:** `signaling_` fica no servidor da chamada (`callServerId`, publicado). Ao ver outro servidor durante a chamada, uma segunda conexão (`browse_`) só recebe o `rooms-update` daquele servidor, sem entrar em sala.
- **Canal da chamada:** a lista lateral mostra os canais do servidor visto. O canal da chamada vem à parte, em `callChannel` (`callChannelOf()` na interface), e alimenta:
  - o painel de voz;
  - a chamada e a pop-out;
  - o menu de participante e o áudio por participante.
- **Selo de voz e linha conectada:** o selo do rail fica no servidor da chamada; a linha "conectada" só aparece nele, porque ids de sala se repetem entre servidores ("Geral", "Jogos").
- **Entrar ou criar uma sala no servidor visto** sai da chamada atual, move a conexão principal e entra quando chega o diretório (`switchCallServer`), como no Discord.
- **Sair da chamada** com outro servidor aberto troca a conexão principal para ele.
- **Limite:** a conexão de navegação não está em sala nenhuma, e o hub manda `user-state-updated` só para a sala. Mudo e câmera dos participantes do servidor visto só atualizam no próximo `rooms-update` (entradas e saídas atualizam na hora).

**Criação de servidor que acontecia mesmo cancelando**
- **Causa:** o X das páginas "Personalize o seu servidor" e "Entrar em um servidor" fica dentro do `<form>` e não tinha `type`. Por isso era um botão de envio, e fechar criava o servidor (ou aceitava o convite colado).
- **Correção:** `type="button"`.
- **Verificação:** o E2E novo pegou o defeito com o bundle antigo, que criou um quinto servidor. Os outros botões sem `type` estão fora de formulários.

**Animações (só o que tem evidência)**
- **Popouts:** antes apareciam secos. Agora seguem o componente Popout do Discord:
  - enum `NONE "1" / TRANSLATE "2" / SCALE "3" / FADE "4"`, com TRANSLATE como padrão (`animation:n="2"`);
  - `didRender` entra 10 ms depois de montar, e `data-popout-animating` cai aos 200 ms;
  - CSS `_faf9c0` (964940.62a0e9d626b739d9.css, SHA-256 `5da78af4…`): TRANSLATE parte 10 px do lado do popout e volta com `transform .2s ease-out`; FADE vai de opacidade 0 a 1 em `.08s ease-out`;
  - `components/popoutAnimation.ts` aplica isso: TRANSLATE nos popovers de conta e soundboard (lado de cima); FADE no de áudio, que bate com a filmagem de ANIMATIONS.md (~65 ms até 93 %, posição fixa);
  - o fechamento continua instantâneo, como filmado;
  - TRANSLATE respeita `prefers-reduced-motion`, como o `.full-motion` do Discord.
- **Pill do rail:** recebeu `translateZ(0)` (camada própria) e `contain: layout size` no contêiner, como em `__58105`.
- **Já conferido:** o resto das transições já batia com o CSS recuperado (botões da chamada .15s, categoria .1s linear, chips, interruptor, fundo do modal, tooltip).
- **Não implementado (sem evidência):** a mola de 598 ms (`--motion-spring-subtle`, token sem uso), a escala do `childWrapperHoverScale` (não se sabe em quais ícones) e a animação dos menus de contexto (filmados: um quadro).

**Testes** (por pedido do usuário, sem a bateria E2E completa a cada entrega, só os da área mexida):
- **Hub:** `npm test` em `cloudflare/` aprovado, com as rotas novas.
- **CTest:** 12/12.
- **E2E novo `run_web_servers_e2e.py`: 15/15.** Cobre:
  - o X não cria nem entra;
  - ver outro servidor mantém a chamada, com canais, painel e selo certos;
  - voltar ao servidor da chamada;
  - criar sala no servidor visto muda a chamada;
  - menus de dono e de membro, os dois modais com os textos do Discord, nome errado recusado e exclusão;
  - estado final no hub.
- **Opções de transmissão: 19/19,** com quatro verificações novas:
  - as três abas;
  - "Tela 1", "Tela 2";
  - 4 px de folga para o contorno;
  - a aba Dispositivos vazia nesta máquina.
- **Popovers com animação:** áudio 8/8, conta 22/22.
- **Bateria completa interrompida** a pedido do usuário. Até ali:
  - passaram login 12, chamada 10, menu do vídeo 5, visão ampliada 13 e janela destacada 17;
  - chat e visão da chamada pararam por um erro de codificação do console do executor (emoji em cp1252), não do cliente;
  - o hover real da transmissão falhou uma vez, depois de passar sozinho minutos antes (o cursor é real).
- **Não verificado:** a transmissão de um dispositivo de verdade (sem câmera na máquina).

**Entrega:**
- `portable-web.ps1` 44/44, pacote `75c4288f21ce62b72849`;
- Área de Trabalho com SHA-256 `5ADED8353FDB52690A8792848B595B4872A7F30B6236D0EFA06E264F58B7064A` (hash conferido);
- backup do anterior em `out/desktop-backups/triscord-web-83E494B1.exe`.

**Pendente:**
- **Publicar o Worker do hub (`cloudflare`, `npm run deploy`).** Sem isso, "Excluir servidor" e "Sair do servidor" recebem 404 do hub publicado e mostram "Não foi possível excluir o servidor agora.". O resto não depende do hub.



**Publicação do Worker (18/10, com OK do usuário)**

`triscord-control` foi publicado na versão `28df1e0a-0c49-48dd-a621-387fea33e2ce`. Subiu a árvore inteira: as rotas de excluir e sair de servidor desta fase e a rodada de recuperação do Codex. Antes, passaram `npm test` e `test:recovery`.

Em produção, `leave` e `DELETE` respondem 401 sem sessão, e o `/ice` vem com `no-store`. O item pendente "Publicar o Worker do hub" desta fase foi concluído.

### Fase 15 — nome, ícone, atualização antes de abrir, instalador e temas (Claude Code, 18/10/2026)

Pedido do usuário:
- escrever "Triscord" com T maiúsculo;
- dar ícone ao programa;
- avaliar um instalador;
- procurar atualizações antes de abrir, como o Discord;
- usar o tema padrão do Discord, com os outros só pelas configurações, e acrescentar um rosa.

Tudo com REA, como pedido ("USE 100% DO REA").

**Nome e ícone**
- O `triscord-web.exe` não tinha recurso nenhum. A barra de tarefas mostrava o ícone genérico e o nome do arquivo, e o notificador caía em `IDI_APPLICATION`.
- `src/web_application.rc.in` agora traz:
  - o ícone do projeto (`assets/triscord-amoled.ico`, ids 1 e `IDI_ICON1`);
  - `VERSIONINFO` com FileDescription e ProductName "Triscord" e a versão do CMake (0.9.22).
- O núcleo recebe `TRISCORD_VERSION` e `applicationDisplayName("Triscord")`; o cliente Qt também passou a "Triscord".
- Lançador NSIS: `Name "Triscord"`, mensagens com "Triscord" e `VIAddVersionKey`.
- Na Área de Trabalho, o arquivo agora se chama `Triscord.exe`.

**Atualização antes de abrir** (`src/update_splash.*`)

Evidência REA, do app do Discord instalado:
- `_app.asar`, sha256 `cbd26748…`;
- o `app.asar` de 221 bytes é o redirecionamento de um mod de cliente;
- Evidence `ev_41fb5f21…`, com `splash/index.html`, `index.css`, `splashScreenPreload.js` e o módulo `splashScreen` de `bundle.js`.

O que foi reproduzido:
- **Janela:**
  - sem moldura, 300×350 (`LOADING_WINDOW_HEIGHT` no Windows), centralizada, fundo `#282b30`;
  - caixa de mídia de 200 px; o vídeo `connecting.webm` é marca do Discord, então entra o ícone do Triscord a 128 px, com cantos arredondados (inferido);
  - status em gg sans 16/500 branco, puxado 30 px para cima;
  - barra de 180×8, raio 4, branca a 10 %, preenchida com `#737f8d`.
- **Estados e textos**, em inglês como no Discord:
  - "Checking for updates…";
  - "Downloading update 1 of 1…";
  - "Installing update 1 of 1…";
  - "Update failed — retrying in N sec…";
  - "Starting…".
- **Tempos:**
  - nova tentativa em `min(10 × tentativa, 60)` s (`scheduleUpdateCheck`), com contagem a cada segundo;
  - a verificação falha se não houver resposta em 10 s.
- **Fonte das atualizações:** os Releases do GitHub do projeto (`Otremba/triscord`), de onde o cliente Electron já se atualiza.
  - Tag `desktop-v<versão>`, separada das `v1.x` do Electron.
  - Arquivos `Triscord-Setup-<versão>.exe` e `.exe.sha256`.
  - O SHA-256 é conferido antes de rodar o instalador com `/S /UPDATE`; em seguida o app sai.
- **Inferido:** 403/404/429 do GitHub contam como "nada novo".
- **Quando verifica:**
  - a versão distribuída verifica sempre (`TRISCORD_SKIP_UPDATE=1` desliga);
  - o build de desenvolvimento só com `TRISCORD_FORCE_UPDATE_CHECK=1`;
  - o verificador de release desliga.
- **Sem rede:** a splash fica tentando de novo, como no Discord.

**Instalador: vale a pena, e foi feito** (`packaging/installer.nsi`, gerado pelo `portable-web.ps1` a partir do mesmo staging verificado)
- **Motivo:** a atualização automática precisa de uma pasta fixa para substituir os arquivos. O lançador portátil extrai cada versão numa pasta nova e acumula cópias.
- **Como o Discord** (Squirrel, em `%LOCALAPPDATA%\Discord`): por usuário, sem administrador e sem assistente.
  - Instala em `%LOCALAPPDATA%\Triscord`.
  - Cria atalhos no menu Iniciar e na Área de Trabalho.
  - Registra a desinstalação em Aplicativos (HKCU).
  - Abre o app ao terminar.
- **`/UPDATE`:** espera o app fechar (até 15 s), não recria atalhos e abre a versão nova.
- Os dados do usuário ficam fora da pasta e sobrevivem.

**Tema padrão:** o do Discord para conta sem preferência.
- No bundle, `ThemeStore` mapeia `UNSET → NJ8.DARK`, com `NJ8 = {ASH:"dark", LIGHT, ONYX:"midnight", DARK:"darker"}`.
- Ou seja: `theme-darker`, que o Discord chama de "Escuro".
- O núcleo e a página agora partem de `darker` (antes, `midnight`); a escolha salva continua valendo.

**Tema rosa "Algodão-doce"** (`COTTON_CANDY`), na nova seção "Temas coloridos" (/xvEMy)
- **Preset** (`web.3a122a9d…`):
  - base clara;
  - `BG_GRADIENT_COTTON_CANDY_1` em 8,5 % e `_2` em 94,28 %, a 180,14°;
  - gradiente no formato `linear-gradient(<ângulo>deg, <cor com saturação 1> <parada>%, …)`.
- **Variáveis** (módulos 153469 `m` e 345815 `c`, `a17f801a…`):
  - base e texto calculados por luminância WCAG e HSL: base clara `rgb(204,216,255)`, texto `rgb(77,0,14)`;
  - mistura de 50 % na base e 38 % no texto;
  - o algoritmo foi portado em `web/tools/extract-client-theme.mjs`.
- **Tokens** (`theme-cotton-candy.generated.css`):
  - os `color-mix` do próprio Discord sobre o tema claro, resolvidos pelo Edge;
  - o mesmo pipeline, sem o tema, reproduziu 91/91 cores do tema claro já gerado;
  - camadas do gradiente pelo módulo 419070 (`7e4c21df…`).
- **Onde cada camada aparece** (`styles/custom-theme.css`), conforme as regras `.custom-theme-background`:
  - quadro do app;
  - lateral (`high`);
  - painel da conta (`highest`);
  - página e chat (`chat`);
  - cabeçalho (`lowest`);
  - campo de mensagem;
  - menus e dicas com `--border-strong`;
  - reações.
- **Desvio:** no Discord este tema é Nitro; aqui é grátis.

**Testes** (só os da área mexida)
- CTest 12/12.
- **E2E novo `run_web_updater_e2e.py`: 6/6**, com um servidor local no lugar da API do GitHub. Casos:
  - nada novo (ignorando a tag do Electron): a janela principal abre;
  - splash 300×350 em `#282b30`, que fecha quando a janela principal sobe;
  - erro 500: contagem regressiva 10, 9, 8… e nova verificação;
  - checksum errado: recusado, arquivo apagado e nada executado;
  - atualização: download de 0 a 100 %, "Installing…", instalador substituto iniciado e saída com código 0.
- Configurações: 8/8.
- **Instalador**, testado numa pasta temporária com `/S /UPDATE /NOLAUNCH`:
  - instalou e registrou "Triscord 0.9.22" (81 MB);
  - o exe saiu com o nome "Triscord";
  - a desinstalação removeu pasta e registro, e os atalhos reais ficaram intocados.
- **Tema rosa**, conferido na interface de fixture: gradiente rosa→azul, camadas translúcidas e o seletor em Aparência.

**Entrega**
- `portable-web.ps1` 44/44, pacote `762e18f902a6b2f724fa`.
- Área de Trabalho: `Triscord.exe`, SHA-256 `624A7014EF969B2131A8DE520C18697B299ACF1F8ACFD1E43517BF82F03CB3B1`.
- Backup do anterior: `out/desktop-backups/triscord-web-5ADED835.exe`.
- Instalador: `out/Triscord-Setup-0.9.22.exe`, sha256 `edf2fcb4029cce8adde24b0e06593e7ad9fbd649bdcc0e5434aeac206046fa3a`.

**Pendente, com o OK do usuário**
- Publicar o release `desktop-v0.9.22` no GitHub com o instalador e o `.sha256`. Sem release, o app só verifica e abre.
- Publicar o Worker do hub (Fase 14).


**Correção do instalador (18/10, depois da primeira instalação do usuário)**

**O que deu errado:**
- `%LOCALAPPDATA%\Triscord` já era a pasta de dados do app (perfil WebView2 e caches em `TriscordNativePreview`, `TriscordNativeDevTools`, `TriscordUiTests`). O instalador pôs o programa ali, e o desinstalador (`RMDir /r $INSTDIR`) teria apagado esses dados.
- A instalação silenciosa não dava sinal, e o usuário a rodou mais de uma vez. A cópia aberta deixou um `.old` preso; a troca seguinte travou em "Feche o Triscord…".
- Os acentos saíam como "instalaÃ§Ã£o", porque o makensis lia o script sem UTF-8.

**Correções:**
- O programa vai para `%LOCALAPPDATA%\Triscord\app`. A desinstalação apaga só essa pasta e remove a pasta-mãe apenas se ela estiver vazia.
- Janela curta de progresso ("Instalando o Triscord"), que fecha sozinha; com `/S`, segue silenciosa.
- **App aberto:** em vez de renomear o exe, o instalador testa se ele está travado.
  - Em `/UPDATE`, espera até 15 s.
  - Na instalação manual, mostra "O Triscord está aberto. Feche-o e clique em Repetir…", com Repetir e Cancelar.
- makensis com `/INPUTCHARSET UTF8`, também no lançador portátil.

**Limpeza da instalação errada:** foram removidos de `%LOCALAPPDATA%\Triscord` só os itens que existem no staging do pacote, mais `Uninstall.exe`, `.old`, a entrada de registro e os atalhos. As três pastas de dados ficaram intactas. O instalador antigo da Área de Trabalho foi substituído pelo novo (sha256 `e482eae4…`).

**Testes em pasta temporária** que imita a estrutura real:
- instalação: 0;
- atualização com o exe travado: esperou 16 s e saiu com 2, sem estragar nada;
- atualização liberada: 0;
- desinstalação: apagou `app`, manteve os dados e removeu o registro;
- instalação manual com o app aberto: mostrou o aviso com Repetir/Cancelar e os acentos certos.

**Nota:** o cliente Electron antigo está instalado em `%LOCALAPPDATA%\Programs\triscord`. O atalho "Triscord" dele foi substituído pelo da primeira instalação.


### Fase 16 — sem servidor fixo, splash animada e seletor com as cores do tema (Claude Code, 18/10/2026)

**Servidor fixo "Triscord" removido** (decisão do usuário: "Remover de vez").
- Era o grupo legado (convite do grupo, sem `serverId`), sempre posto à frente da lista pelo núcleo.
- Agora a lista traz só os servidores da conta (`GET /servers`). Sem servidor selecionado, ou se o selecionado sumiu, o núcleo mostra o primeiro; sem nenhum, não conecta a nada (`connection: offline`, sem canais).
- **Consequência aceita:** quem ainda usa o cliente Electron antigo fica numa sala que o Triscord novo não alcança.

**Splash animada.** Evidência: `splash/videos/connecting.webp` do `app.asar`, 400×400, 64 quadros em 1050 ms, em ciclo.
- O ângulo de cada quadro foi medido contra o quadro 0, testando todas as rotações em passos de 3°: parado, recua até -9°, gira uma volta no sentido horário passando até 369° e assenta em 360°.
- O logo ocupa 144 px de largura no quadro de 400, ou seja, 72 px na caixa de 200.
- O Triscord desenha seu glifo branco (os pixels claros do ícone, recortados) com esses ângulos, a cada quadro gravado.
- **Diferença:** o borrão de movimento dos quadros do Discord não foi reproduzido.

**Seletor de transmissão** (pedido: a borda branca e o botão destoavam do tema).
- **Evidência:** o componente real (`316898225cbe6756.js`: `e4` cartão, `e7` grade, `e8` vazio) e o CSS `__2f580` do cache atual do Discord (sha256 `5fc7cee3…`, extraído com o leitor `blockfile.cjs`).
- **A borda branca era invenção minha.** No Discord é um anel de 2 px a 4 px por fora (`radius-md`): `--background-mod-strong` no hover e `--brand-500` na fonte selecionada.
- **O botão branco é do Discord**, em qualquer tema: `--white` com texto `--black`, padding 12/24, 14 px medium, sobre um escurecimento `--opacity-black-40` (antes eu usava `brightness(.5)` na imagem).
- **Medidas:** grade de 2 colunas `1fr` com espaço de 24/16; cartão até 447 px em 16:9; nome a 8 px abaixo, em 14 px medium e cor `--text-default` (antes 16 px).
- **Dispositivos:**
  - o botão do cartão diz "Selecionar" (e72JFB);
  - sem dispositivos, o estado vazio do Discord: ícone de vídeo em `--icon-muted`, "Você não tem nenhum dispositivo de captura disponível." (/z3YaZ, 18 px medium, `--text-strong`) e "No futuro, você poderá usar esta aba para compartilhar a partir de dispositivos específicos, como sua câmera." (agwSGA, 14 px medium, `--text-subtle`);
  - o link "Saiba Mais" do Discord ficou de fora.
- **Ferramenta nova:** `web/tools/refresh-tokens.mjs` regera o `tokens.generated.css` a partir da evidência já resolvida (`out/web-tokens/`), quando o CSS passa a usar um token recuperado.
  - Entraram `--opacity-black-40`, `--space-12` e `--space-24`, além de tokens que o CSS do Markdown já usava.
  - O tema rosa foi regenerado e as cores do tema claro bateram 99/99.

**Testes:**
- CTest 12/12;
- atualizador 6/6;
- servidores 15/15;
- opções de transmissão 18/19, com as abas, os nomes, o anel e o estado vazio aprovados.
- **Falha a reconfirmar:** "real hover draws the quality pill" falhou duas vezes com `hovered=0`, porque a janela nativa não recebeu o cursor real. O texto do hover (`1080P | AO VIVO`) está certo e o cartão nativo não mudou nesta fase.

**Entrega:**
- pacote 44/44;
- Área de Trabalho: `Triscord.exe` portátil (`A512AB9F…`, backup 624A7014) e `Triscord-Setup-0.9.22.exe` (sha256 `1a40f252…`);
- o usuário já tinha instalado (em `...\Triscord\app`, aberto): para atualizar, basta fechar e rodar o instalador novo.

## Revisão do Codex

Revisão em 16/10/2026. **Concordo com um protótipo comparativo; não aprovo ainda a migração completa.** Esta revisão não altera a tecnologia escolhida pelo usuário, não autoriza instalações e não aceita um novo orçamento de memória em seu nome. As porcentagens de fidelidade/desempenho da conversa são estimativas sem experimento que as sustente. Usar Chromium facilita implementar layouts web, mas não garante equivalência visual ou bom desempenho.

### Revisão das decisões, item por item

1. **Concordo com o núcleo como fonte da verdade, com uma ressalva.** Separar estado de domínio e serviços do MainWindow é útil mesmo se o protótipo for descartado. A interface precisa manter estado de apresentação: foco, seleção, scroll, rascunhos, menu aberto e animação. Isso não deve virar uma viagem C++↔JS por tecla. Permissões e transições de domínio ficam no núcleo, e o servidor continua sendo a autoridade final sobre acesso. Evitar um AppState que concentre rede, mídia, persistência e todos os comandos em uma classe única; separar modelos e controladores por domínio.

2. **Concordo com rede e segredos no C++, discordo da afirmação absoluta sobre convites.** Tokens de sessão e credenciais TURN não precisam chegar ao JS. Um convite digitado/colado em um input web necessariamente passa pelo JS. Para gerar/copiar convite, a ponte pode oferecer `copyServerInvite(serverId)` e devolver apenas sucesso, usando clipboard nativo; ao aceitar convite, deve admitir explicitamente essa exposição transitória. A ponte não deve expor um proxy HTTP genérico. Imagens devem usar IDs locais opacos, e o C++ deve resolver/cachear somente URLs autorizadas; não aceitar URL arbitrária do renderer, que criaria uma via de SSRF/acesso à rede local. CSP precisa cobrir connect-src, img-src, media-src, frame-src e object-src, além das restrições do host.

3. **Concordo com assets locais, com requisitos de distribuição.** Folder mapping exige uma pasta real: recursos comprimidos dentro do exe não viram arquivos mapeáveis automaticamente. Escolher extração versionada com integridade verificada ou handler de recursos; não mapear diretórios pessoais, raiz da instalação ou pasta de uploads. Usar origem HTTPS local fixa e mapeamento com acesso entre origens restrito. Separar assets somente de leitura, cache e User Data Folder gravável. Sem isso, a proposta de exe portátil fica incompleta. Aplicar CSP também a respostas do handler de mídia e validar caminhos/canonicalização.

4. **Concordo com TypeScript, CSS próprio e Preact como primeira escolha.** O benefício principal é manutenção de componentes, estado e acessibilidade. O tamanho comprimido de uma biblioteca não representa memória residente. Os processos Chromium, DOM, imagens, buffers e trabalho por quadro devem determinar a decisão. Não criar uma biblioteca de componentes própria em TS puro antes de medir necessidade real.

5. **Concordo com protocolo tipado/versionado, mas geração não basta.** Acrescentar identificação da instância do renderer, revisão do estado, correlação de respostas, erros estáveis e limites de tamanho/frequência. A validação C++ precisa ser executada de fato; gerar structs/tipos não garante validar JSON Schema. Rejeitar campos extras e limites inválidos. Não usar números JS acima de 2^53−1 para contadores de 64 bits; serializar esses valores como strings. Comandos repetidos por retentativa precisam de semântica explícita, especialmente criar servidor/convite.

6. **Concordo em manter Qt e migrar por fases; discordo de considerar a janela um reaproveitamento direto.** `native_frame.h/.cpp` recebe QWidget, não QWindow. Haverá adaptação de HWND, hit testing e DPI. QWindow depende de Qt Gui; Qt Core sozinho não hospeda a janela. WebView2 exige thread STA com message pump e não aceita bloqueios síncronos/reentrância indiscriminada nos callbacks. Manter áudio/codec fora dessa thread e publicar resultados de forma assíncrona. Testar resize, minimizar/restaurar, múltiplos monitores, DPI 100/125/150%, teclado/IME, acessibilidade e recuperação de renderer. Fonte: [threading do WebView2](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/threading-model).

7. **Concordo em provar MinGW antes de desenvolver a interface.** Carregar a DLL resolve o carregamento, não toda a compatibilidade dos headers/helpers COM. Validar primeiro um executável mínimo com os headers oficiais e interfaces COM, sem depender de WRL/WIL específicos de MSVC. Carregar WebView2Loader.dll de caminho controlado, conferir arquitetura e HRESULTs. Se a casca precisar de MSVC, não ligar diretamente objetos C++/Qt MinGW a ela: usar uma fronteira C explícita e restrita ou IPC, ou migrar toda a cadeia nativa para MSVC com dependências compatíveis. O CI já tem um caminho MSVC, mas isso não prova interoperabilidade de binários. SDK, loader e runtime são artefatos diferentes.

### Respostas às seis perguntas abertas

**1. Vídeo: concordo em comparar A e B; discordo de escolher B antecipadamente e de prometer uma única cópia.** SharedBuffer expõe memória ao JS; não é uma textura GPU compartilhada pronta para composição. Conversão I420→RGBA, construção de VideoFrame e upload de textura podem acrescentar cópias/sincronização. O código atual já publica QImage em ScreenService, portanto A também não prova custo zero. Em 1920×1080×4×60, somente uma passagem RGBA representa aproximadamente **498 MB/s** (475 MiB/s); I420 na mesma resolução/fps representa cerca de 187 MB/s, antes das outras etapas. São cálculos de volume, não medições de desempenho.

Para B, usar buffers de leitura com quantidade/bytes limitados, ACK de consumo, geração/sequence por stream, descarte de quadros atrasados e liberação no stop/reload/crash. Nunca enfileirar vídeo ilimitado pelo canal JSON nem sobrescrever um buffer em leitura. O renderer pode travar sem devolver ACK: o núcleo deve continuar atendendo áudio e limitar retenção. A API exige liberar cada view compartilhada quando terminar; confirmar suporte por QueryInterface no runtime real, em vez de confiar apenas no número “155” informado. Não verifiquei o runtime desta máquina nesta revisão. Fonte: [SharedBuffer/ICoreWebView2_17](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_17?view=webview2-1.0.4129.50).

Investigar como terceiro experimento a composição nativa integrada ao host, se o custo/oclusão de A ou B for inadequado. Isso não é uma API comprovada de importação de textura C++ em canvas do WebView2. CompositionController, por si só, não elimina os problemas de ordenação entre DOM e superfícies nativas. Testar menus sobre vídeo, recorte, sobreposição, resize e ocultação; não declarar DirectComposition automaticamente zero-copy. WebRTC no navegador seria outra arquitetura de mídia e não entra como substituição silenciosa do núcleo.

**2. Estado: concordo com snapshot inicial + deltas versionados.** Separar snapshot de sessão de UI, revisão monotônica e comando/resposta com requestId. Delta só aplica à revisão/base esperada; lacuna, reinício do renderer ou versão incompatível pede novo snapshot. “Só eventos” exige replay/ordenação e recuperação muito mais difíceis. Não replicar o protocolo bruto de Socket.IO no renderer. Fixtures determinísticas do modelo de apresentação facilitam testes de UI; os testes do backend continuam verificando os contratos HTTP/WebSocket reais, separados do transporte interno da ponte.

**3. Perfil: concordo em enriquecer participantes, mas não é custo zero.** Nenhuma mudança em Workers é obrigatória apenas para trocar Qt Widgets por web. Hoje `resolveSessionHash` consulta id/nick/expiração; `join` publica avatar como cor sanitizada do payload, não avatar_url. Para corrigir isso independentemente do front, incluir somente campos públicos necessários na consulta existente e gerar `publicProfile` opcional: accountId, nick/displayName, avatarUrl e uma revisão. Manter `avatar` como cor por compatibilidade; não mudar seu tipo. Nunca encaminhar o objeto de sessão/attachment, sessionHash, email, note ou a conta privada inteira.

Adicionar colunas públicas à consulta existente não exige uma segunda consulta, mas aumenta bytes lidos, attachments e eventos. A revalidação atual pode consultar sessão/associação a cada pacote autenticado: não anexar banner/bio/temas completos a todas essas leituras. Carregar perfil detalhado sob demanda pelo C++ usando o `/profile/:id` público existente, com cache limitado; atualizar a versão/invalidar após edição. Um endpoint em lote só é necessário se medições mostrarem muitas leituras individuais. Em `room-joined`, `user-joined` e diretório, usar o mesmo DTO público pequeno e filtrado, derivado do servidor, não campos arbitrários enviados pelo cliente.

Avatares/faixas servidos pelo Worker de auth consultam o D1 em cache miss; a cache LRU do cliente e a cache HTTP reduzem tráfego, mas não são garantia de cache de borda nem de gratuidade ilimitada. Broadcasts já ampliam payload conforme participantes/eventos; imagens nunca devem viajar em base64 nos eventos. Medir consultas/linhas lidas, bytes servidos e broadcasts antes de afirmar impacto no plano gratuito. Não consultei preços/limites de plano nesta revisão e não recomendo contratar produtos.

**4. Design-spec: concordo com Markdown + JSON por tela e tokens.json, com um contrato de evidência obrigatório.** O diretório ainda não existia ao revisar. Sugiro `schema.json`, `tokens.json`, `screens/<id>.json`, `screens/<id>.md` e `evidence/index.json`. JSON deve registrar schemaVersion, screenId, variante/estado, viewport, DPI/zoom, locale, tema, geometria, layout, tipografia, assets próprios e interações. Cada medida/valor importante precisa de referência à fonte (artefato e SHA-256, módulo/offset ou região da captura, Evidence ID REA quando existir), autoridade e classificação observado/derivado/hipótese/desconhecido. Registrar explicitamente lacunas e tolerâncias; não preencher ausência com uma falsa precisão.

Separar tokens medidos, aliases semânticos e escolhas próprias do Triscord. Não inventar valor para o token global com base em uma única imagem. JSON alimenta geração/testes; Markdown explica evidência, decisões e limitações. Fixtures e capturas devem ter provenance/DPI e usar imagens/fontes autorizadas. Mudanças de React/Qt não fecham as obrigações REA abertas. Essa especificação é suficiente para minha futura geração com REA; não a gerei nesta revisão.

**5. Preact: concordo.** Usar componentes pequenos, CSS e virtualização apenas onde a lista exigir; evitar atualizações da árvore inteira em cada frame. A escolha pode ser revista pelo protótipo, mas não atribuir economia de centenas de MB à diferença de biblioteca. Vídeo deve atualizar sua superfície sem atravessar renderização declarativa de estado por quadro.

**6. Segurança: concordo com renderer não confiável, com controles adicionais.** Conferir origem exata, documento e instância em cada mensagem; bloquear navegação externa, novas janelas e subframes não necessários. Invalidar requisições/capacidades ao navegar ou recarregar. Expor comandos específicos, sem shell, caminhos livres, objetos COM genéricos ou proxy de rede. Markdown/chat não deve virar HTML arbitrário. Aplicar limites por comando, validação de IDs e autorização no núcleo/servidor. Origem local e CSP não tornam XSS inofensivo: JS comprometido ainda pode acionar comandos autorizados do usuário. Depuração/CDP apenas em desenvolvimento, sem porta pública; negar permissões de câmera/microfone/download do navegador se o C++ é responsável por elas. Fonte: [segurança WebView2](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security).

### Memória, distribuição e critérios do protótipo

**Discordo de tratar “250 MB” como decisão tomada, “120 MB impossível” como fato medido, ou “WebView2 bem mais leve que Electron” como garantia.** O runtime usa múltiplos processos; compartilhar instalação não significa eliminar memória de execução. Precisa medir na mesma máquina, tamanho, conteúdo e estado, somando os processos atribuíveis ao app. Relatar private bytes/commit e working set separadamente, GPU quando disponível, sem somar páginas compartilhadas como se fossem alocações privadas independentes. Fonte: [modelo de processos](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model).

O usuário ainda decide o orçamento. Até lá, o protótipo deve entregar números sem afrouxar o limite antigo para “passar”: abertura fria/quente, idle estabilizado, minimizar, modal com GIF, grade de miniaturas, vídeo em foco 1080p30/60 e resize. Registrar CPU por intervalo, memória p50/p95/pico, frame time p95, quadros descartados, latência captura→tela e caminho de cada cópia. Rodar ciclos de entrar/sair e recarregar para detectar retenção. Incluir todos os processos e manter navegador/Discord no mesmo estado na comparação.

**Concordo com Evergreen como primeira hipótese de distribuição**, verificando disponibilidade/versão e erro recuperável na inicialização. Não presumir que existe em todo PC porque existe aqui. Fixed Version oferece versão controlada, mas aumenta o pacote e transfere a atualização do runtime para nós. Planejar instalação offline, loader x64/ARM64, User Data Folder, licenças/avisos, limpeza/atualização de assets e recuperação de `ProcessFailed`. Fonte: [Evergreen e Fixed Version](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version).

**Concordo com Playwright para UI web; discordo de substituir todo pywinauto.** Manter teste do host nativo para instalação/inicialização, moldura, diálogos de arquivo, clipboard, foco e acessibilidade. Capturas determinísticas exigem mesma fonte, escala, versão e estados; diff de pixels deve ter regiões/tolerâncias justificadas e verificação de comportamento. Uma ponte falsa prova o front, não o núcleo ou backend. O E2E já iniciado pelo Claude continua útil e não deve ser abandonado por causa desta proposta.

### Decisão recomendada

Concordo em concluir o E2E atual e, quando o usuário aprovar orçamento/SDK, executar **somente a fase 0**. Primeiro gate: casca/COM/MinGW + carga de assets + ponte restrita + recuperação do renderer. Segundo: layout representativo e vídeo A/B com medições completas. Só depois escolher o caminho e autorizar migração incremental, mantendo um build Qt Widgets utilizável até a equivalência funcional. Não implementar mudanças de backend, design-spec ou cliente apenas com base nesta revisão.

## Prévia local da câmera — implementada em 0.9.25

O núcleo agora pode manter uma captura local independente e temporária para testar a câmera, sem conectar/publicar WebRTC. A UI recebe miniaturas efêmeras (até 640×360, 5 fps, JPEG ≤128 KiB) por evento, como exceção explícita ao transporte de vídeo ao vivo fora do JSON; elas nunca entram no estado da sessão. Uma licença com renovação e expiração limita a captura caso a interface desapareça. A transmissão já ativa fornece seus quadros sem abrir outra captura. Ver CAMERA_PREVIA_20261018.md e tests/e2e/run_web_camera_preview_e2e.py para evidência, encerramento e isolamento do par remoto. Essa validação não substitui webcam física nem duas máquinas em redes diferentes.

## 0.9.26 — instalador quebrava em Windows mais antigo (Claude Code, 18/10/2026)

**Sintoma (PC de um amigo):** o 0.9.25 instalava, mas não abria: "Entry Point Not Found — `__std_parallel_algorithms_hw_threads` … `app\D3DCOMPILER_47.dll`".

**Causa:**
- o `windeployqt` (Qt MinGW) copia para o pacote o `D3DCompiler_47.dll` do `System32` da máquina de build;
- o desta máquina (Windows 11 26200) importa `msvcp_win.dll!__std_parallel_algorithms_hw_threads`, que só existe em builds recentes do Windows;
- como a cópia fica ao lado do exe, ela tem prioridade sobre a do sistema do usuário, e falha.

**Correção:**
- `scripts/portable-web.ps1` e `scripts/build.ps1` passam `--no-system-d3d-compiler --no-system-dxc-compiler`;
- o `triscord-web.exe` passa a carregar o `d3dcompiler_47.dll` do próprio Windows, presente desde o 8.1;
- `tests/verify_web_release.py` ganhou "no Windows system DLL bundled": falha se houver `d3dcompiler_47`/`dxcompiler`/`dxil` ou qualquer DLL idêntica a uma do `System32`.

**Verificação:**
- pacote 46/46;
- os binários do pacote só importam DLLs do próprio Windows 10, mais as do pacote; `msvcp_win.dll` não aparece mais;
- não foi testado num Windows antigo de verdade.

**Entrega (Área de Trabalho):**
- `Triscord.exe` `5763A4B0…`, com backup do 0.9.25 em `out/desktop-backups/`;
- `Triscord-Setup-0.9.26.exe` `fdaba680…`.

## 0.9.27 — login com Google em outros computadores (Claude Code, 18/10/2026)

**Sintoma:** no PC de um amigo, "Login com Google indisponível: configuração ausente".

**Causa:** o segredo do cliente OAuth desktop só existia no registro desta máquina (`googleClientSecret` nas configurações).

**Correção:**
- `TRISCORD_GOOGLE_CLIENT_SECRET_FILE` no CMake gera `generated/google_client.h`, terceira opção de `googleClientSecret()`;
- `portable-web.ps1` exige `out/google-client-secret.txt` (arquivo local e ignorado; o segredo nunca entra no código-fonte);
- `verify_web_release.py` ganhou "Google sign-in secret built in".

O Google não trata segredos de cliente desktop como confidenciais (RFC 8252 §8.5).

## 0.9.28 — entrar só com o nick; senha depois (Claude Code, 18/10/2026)

**Auth Worker:**
- `POST /auth/nick {nick, password?}`:
  - nick livre: cria a conta `n_<hex>`, sem e-mail, e responde 201;
  - nick ocupado com senha: exige a senha (401 `password_required` ou `invalid_credentials`);
  - nick ocupado sem senha: 409 `nick_taken`;
  - depois de 10 falhas, a conta bloqueia por 15 min (429).
- `POST /password {password, current_password?}`, com sessão, cria ou troca a senha. A senha é guardada como PBKDF2-SHA256 com 100k iterações e sal de 16 bytes.
- `serializeAccount` ganhou `has_password` e `google`.
- Migração aditiva `migrations/0004_password.sql` (já no `scripts/migrate.mjs`): `password_hash`, `failed_logins`, `locked_until`.
- O hub lê a mesma tabela `accounts` e não muda.

**Núcleo:**
- comandos `signInNick` e `setPassword`, com as mensagens de erro em português;
- `profile.hasPassword` e `profile.google`.

**Interface:**
- Tela de login redesenhada:
  - campos "Nome de usuário" e "Senha" (com Mostrar/Ocultar) e a dica de senha opcional;
  - botão "Entrar", divisor "ou" e "Entrar com Google" com o G;
  - logo no canto e fundo com luzes lentas (paradas com `prefers-reduced-motion`).
- Configurações → Conta → "Senha e autenticação": "Criar senha" ou "Alterar senha", em modal com confirmação.

**Testes:**
- `cloudflare-auth/tests/password.test.mjs`;
- `tests/e2e/run_web_nick_login_e2e.py`: 14/14 com o cliente real e os Workers locais;
- Google 12/12, configurações e conta 22/22, CTest 12/12;
- pacote 47/47.

**Site (`site/`):** reconstruído a partir do que está publicado em triscord.pages.dev, porque não havia fonte local.
- `site/stage.mjs` monta `desktop/out/site-dist` com o instalador em `/download/`;
- a meta de verificação do Google e os endereços `/privacidade` e `/termos` foram mantidos;
- privacidade e termos foram atualizados para o login por nick.

**Publicado com OK do usuário (18/10):**
- migração remota do D1: 3 colunas aditivas;
- triscord-auth, versão `3e3fefc1`, conferida em produção sem criar conta;
- Pages `c408ab10`: em triscord.pages.dev, o instalador baixado tem o SHA-256 `524924eb…`, que confere com o do pacote.

## 0.9.29 — sem áudio e sem tela entre duas casas; GIF parado no perfil (Claude Code, 18/10/2026)

**Sintoma (amigo no servidor do usuário):**
- um não ouvia o outro;
- a tela compartilhada não aparecia;
- o avatar e o banner GIF do usuário apareciam parados para o amigo.

**Causa do áudio e da tela:** o cliente WebView2 nunca buscava os relays TURN do hub (`GET /ice`); só o `MainWindow` do cliente Qt fazia isso. Além disso:
- `VoiceCall` e `ScreenCall` montavam a lista de ICE uma única vez, ao abrir o app, antes do login;
- o evento `ice-servers` do hub (que traz só STUN) **substituía** essa lista.

Sem TURN, quando a conexão direta falha (CGNAT ou NAT simétrico, comuns em casa), não passa mídia nenhuma.

**Correção:**
- `CoreSession::refreshIce()` roda depois do login, a cada 240 s e ao entrar em voz sem relay válido; a lista é limpa ao sair da conta;
- cada peer novo monta a lista na hora: `resolveIceServers()` (relays da sessão, servidores padrão e o que veio do hub);
- o evento `ice-servers` passou a ser **somado** à lista, não a substituí-la;
- novo `hasSessionIceServers()`.

**Prova do relay:** `tools/turn_probe.cpp` (`triscord-turn-probe`, ferramenta de dev) usa as credenciais reais de produção, convertidas pelo mesmo código das chamadas. Os dois lados ficam só em relay (`TransportPolicy::Relay`). A mensagem passou pelo TURN da Cloudflare em 427 ms, com par selecionado "relay".

**Avatar e banner de outra pessoa:** o card de perfil agora mostra o GIF original (até 1 MB, mais de um quadro). As listas continuam com o primeiro quadro em PNG. O E2E de participante passou a usar GIF animado: 22/22.

**Testes:**
- CTest 12/12 (`native-ui` instável: passou ao rodar de novo);
- E2E: chamada 11/11, participante 22/22;
- opções de transmissão: só falhou "real hover", falha de ambiente conhecida;
- pacote 47/47.

**Não testado:** uma chamada real entre duas redes diferentes. O relay foi provado isoladamente.

**Atualização automática (18/10):** a release `desktop-v0.9.29` foi publicada em Otremba/triscord, com o OK do usuário. Detalhes:
- a release não está marcada como "latest", para não afetar o `latest.yml` do app Electron;
- uma 0.9.28 a encontra e a valida pelo SHA-256 (simulação contra a API pública);
- daqui em diante, cada versão nova precisa da sua release `desktop-v<ver>`, com o instalador e o `.sha256`.

## 0.9.30 — voz baixa, indicador verde, ruído, avatares, volume da transmissão e tela preta (Claude Code, 18/10/2026)

Relatos dos amigos do usuário, todos corrigidos e testados.

- **Voz muito baixa.** Não havia controle de ganho automático (o Discord tem um ligado por padrão).
  - O AGC da speex foi testado primeiro e não atuou: ficou em -3 dB em 20 s, porque depende do detector de fala dela.
  - Entrou `VoiceGainControl` (`voice_processing`): mede o nível só nos quadros de fala (9 dB acima de um piso de ruído rastreado), sobe até +20 dB a 10 dB/s, desce a 50 dB/s e tem limitador suave.
  - Nova opção "Controle de ganho automático" em Voz e vídeo, ligada por padrão.
  - Teste unitário: uma voz de -40 dBFS sobe pelo menos 12 dB, sem clipping; voz alta desce; ruído sozinho não sobe.
- **Supressão de ruído.** RNNoise v0.1.1 da Xiph (BSD-3, modelo no próprio código), via FetchContent ou `.toolchain/rnnoise`. Detalhes:
  - roda em quadros de 10 ms;
  - os prefixos `rnn_*` evitam conflito com a libopus;
  - a speex ficou só para o cancelamento de eco;
  - o teste exige pelo menos 10 dB de redução de ruído.
- **Verde que às vezes não acendia.** O limiar de `VoiceActivity` era -36 dBFS e passou a ligar em -42 dBFS e manter até -46 dBFS. O AGC também ajuda.
- **Avatares sem clicar.**
  - O núcleo busca o perfil público de quem aparece na lista ou no chat (`prefetchAvatar`).
  - Novo campo `avatars` na sessão (conta → quadro parado e GIF), enviado só quando muda. O GIF não vai mais nas `categories`, que são reenviadas a cada mudança de "falando".
  - O cartão da chamada mostra o GIF; o chat mostra a foto, que anima com o mouse por cima, como no Discord.
- **Volume da transmissão.**
  - O menu do botão direito ganhou sliders "Volume do usuário" e "Volume da transmissão" (novo tipo `slider` no `ContextMenu`).
  - O "Volume do Alto-falante" agora também vale para o áudio das transmissões (`ScreenAudio::setOutputGain`).
- **Compartilhamento preto e miniaturas pretas no PC de um amigo.**
  - O codificador de tela era `HardwareOnly`. Agora tenta o hardware primeiro e, se não houver, usa o codificador de software (NV12 lido para a memória).
  - A captura WGC ganhou fallback GDI quando falha, quando só entrega quadros pretos ou quando a miniatura não chega em 300 ms. A imagem do GDI vai para uma textura D3D11.
  - Se não houver dispositivo D3D11 de hardware, usa WARP.
  - Para testar: `TRISCORD_CAPTURE_BACKEND=gdi` e `TRISCORD_SCREEN_ENCODER=software`. Com os dois, o E2E de transmissão passou em 19 de 20: o Bob recebe 1080p com imagem real, e só falhou o "real hover", de ambiente.
- **Teste "redes diferentes"** (`tests/e2e/run_web_wan_e2e.py`), 11/11:
  - dois clientes em relay-only (`TRISCORD_ICE_RELAY_ONLY=1`), com o TURN de produção;
  - Bob é conta por nick e tem GIF;
  - voz sintética baixa (`TRISCORD_SYNTHETIC_VOICE=1`);
  - o log mostra `ice: voice/video connected via relay/relay` nos dois lados;
  - cada um ouve o outro a cerca de -24 dBFS: saiu a -40 e o AGC subiu;
  - o verde acende nos dois lados e a câmera chega pelo relay;
  - GIF no cartão, foto no chat e o slider de volume funcionam.
- **Outros testes:** CTest 12/12, voz 21/21, chamada 11/11, participante 25/25, transmissão 20/20 (normal), configurações 9/9, login por nick 15/15, pacote 47/47.
- **Release** `desktop-v0.9.30` no GitHub (`make_latest: false`); uma 0.9.29 encontra a 0.9.30 e o checksum confere.
- **Não verificado:** hardware real sem codificador, ou com WGC preto. O fallback foi testado forçando os modos.

## 0.9.31 — borda amarela, seletor de tela, registro em arquivo (Claude Code, 18/10/2026)

**Borda amarela:**
- O WGC passou a usar `IsBorderRequired = false` (`IGraphicsCaptureSession3`, declarada em `wgc_abi.h`). O teste pode reativá-la com `TRISCORD_CAPTURE_BORDER=1`.
- Prova (`tools/capture_border_probe.cpp`): 210 pixels amarelos na borda com ela permitida e 0 com o novo padrão, com a captura funcionando (59 quadros).

**Miniaturas pretas no PC do usuário:**
- Não reproduzi:
  - no build de dev, com as DLLs do pacote;
  - com dispositivos reais;
  - em chamada e depois de transmitir, com e sem áudio do sistema;
  - no binário instalado, aberto direto e aberto pelo instalador (medido via CDP).
- Em todos esses casos as miniaturas vieram com imagem.
- Mesmo assim:
  - o seletor guarda as miniaturas que chegam antes da resposta da lista (antes eram descartadas por geração);
  - mostra "Prévia indisponível" depois de 4 s, em vez de ficar preto;
  - cada abertura tem um id próprio. Antes, um seletor ainda fechando fechava o que tinha acabado de abrir, o que foi reproduzido no E2E.
- Novo `tests/e2e/run_web_share_thumbnails_e2e.py`: abre o seletor real 5 vezes e mede os pixels. Opções `--real-devices` e `--share-audio`.

**Registro em arquivo:**
- Sem console, o app grava em `%LOCALAPPDATA%\Triscord\logs	riscord.log` (o anterior fica em `triscord.previous.log`). O arquivo é compartilhado (`_SH_DENYNO`), então dá para abri-lo e copiá-lo com o app aberto.
- Contém nomes de comando, caminhos de conexão, linhas de captura e avisos; nada de tokens ou senhas.
- Diagnóstico de captura com HRESULT (`capture: ...`).

**Configurações:** as linhas de switch consecutivas ganharam 20 px de espaço e um separador.

**Testes:** seletor 5/5, transmissão 20/20, pacote 47/47.

**Release** `desktop-v0.9.31` publicada.

## Supressão de ruído: porta de voz e "Alta qualidade" com DeepFilterNet 3 (Claude Code, 18/10/2026)

**Pedido:** "parar de ouvir o teclado do meu amigo, os carros na rua e as crianças de fundo". O processamento roda em quem fala: o amigo precisa estar com a versão nova.

### 1. Porta de voz (`VoiceGate`, `src/voice_processing.{h,cpp}`)

Fica ligada junto com a supressão de ruído e usa a probabilidade de fala que o RNNoise já calcula (`rnnoise_process_frame`).
- **Alinhamento:** a saída do RNNoise é o bloco de 10 ms anterior (medido: o pulso aparece uma chamada depois). Por isso a probabilidade do bloco seguinte serve de lookahead de graça.
- **Quando abre:** o bloco e o seguinte são fala (≥ 0,5), e o nível está a até 20 dB do de quem fala.
- **Nível robusto:** é a 5ª menor energia de 8 fatias de 2,5 ms, então um clique não engana a medida.
- **Nível de quem fala:** sobe rápido com a fala e desce 0,5 dB/s enquanto alguém fala. Acompanha o volume do microfone (`inputGainChanged`).
- **Tempos:** abre em 5 ms. Depois de 30 ms de fala, segura 150 ms e fecha em 200 ms. Um bloco solto fecha em 10 ms. Fechada, atenua −40 dB. Na fala, o ganho é exatamente 1.
- **Vozes de fundo:** crianças em outro cômodo ou vozes da rua são fala para o RNNoise, mas ficam muito abaixo de quem está no microfone. A regra dos 20 dB as corta quando o amigo está calado.

**Testes** (`tests/voice_tests.cpp`):
- `voiceGateRemovesTypingBetweenSentences`: voz de formantes com teclado nas pausas. Cliques ≥ 20 dB abaixo do RNNoise sozinho (medido em sonda: −40 dB); ≥ 99% da fala idêntica bit a bit.
- `voiceGateRemovesBackgroundVoices`: voz de "criança" (280 Hz) 30 dB abaixo, cortada ≥ 20 dB a mais; uma pessoa a 6 dB continua passando.
- `voiceGateTiming`: ataque, hold, release e bloco solto.
- `syntheticCallVoicePassesTheGate`: a voz sintética dos E2E passa igual com a porta e acende o anel verde em todos os quadros de fala.

**Limites conhecidos:**
- Digitar *por cima* de uma voz distante, com o amigo calado, ainda deixa passar alguns cliques. As duas regras passam por um bloco; abrir só no 2º bloco cortava o começo das palavras.
- Com o amigo falando, o que está junto da voz depende do supressor (próxima seção).
- Uma criança gritando ao lado do microfone não é "fundo": nenhum supressor gratuito separa duas vozes próximas.

### 2. DeepFilterNet 3 como "Alta qualidade" — viável, integrado

**Build:**
- libDF (Rust, MIT/Apache) com a API C (`--features capi`), alvo `x86_64-pc-windows-gnu`, com o MinGW 13.1 do projeto.
- `scripts/build-deepfilter.ps1` instala o Rust 1.99.1 localmente em `.toolchain/rust`, usa o commit `d375b2d` com `--locked` e faz `strip` (`df.dll`: 41 → 29,7 MB, só DLLs do Windows). Copia o modelo (8 MB) e as licenças das 99 crates para `.toolchain/deepfilter`.
- Todas as crates são MIT/Apache/BSD/Zlib/CC0/Unicode: nada pago e nada copyleft.
- O binutils do MinGW 13.1 avisa sobre `-exclude-symbols` (diretiva nova do Rust) ao linkar a `.a`, sem efeito. Por isso o cliente carrega a DLL em tempo de execução, sem linkar.

**Medições** (Ryzen 5 5600X, um thread, `dfbench`). Fala real da amostra do DeepFilterNet (CC BY-NC, só para medir, nunca copiada nem distribuída), ruído a 5 dB SNR. Os valores são a melhora de SI-SDR:

| | CPU por 10 ms | Latência | Fala limpa (SI-SDR) | Teclado durante a fala | Carro/rua | freesound 2530 | freesound 573577 |
|---|---|---|---|---|---|---|---|
| RNNoise | 0,12 ms | 10 ms | 20,0 dB | +4,3 dB | +9,7 dB | +3,4 dB | +10,0 dB |
| DFN3 | 0,59 ms (p99 0,74) | 30 ms | 38,4 dB | +13,7 dB (cliques −60 dB) | +14,9 dB | +9,2 dB | +6,4 dB |
| DFN3-LL | 1,88 ms | 10 ms | 40,3 dB | +14,1 dB | +8,8 dB | +9,6 dB | +10,8 dB |

- **Carregamento:** `df_create` leva ~340 ms, por isso roda em uma thread. Até lá, ou se faltar a DLL, fica o RNNoise.
- **Escolha:** o DFN3 padrão. O LL custa 3× mais CPU por 20 ms a menos.

**Integração:**
- `src/voice_deepfilter.{h,cpp}` carrega `deepfilter\df.dll` e o modelo ao lado do exe (`LoadLibraryExW`). Antes de cada criação verifica leitura e SHA-256 do modelo fixado; arquivo ausente ou corrompido mantém RNNoise, pois a API Rust aborta com um modelo inválido.
- No modo alta qualidade, o `VoiceProcessor` continua rodando o RNNoise só pela probabilidade de fala e usa a saída do DFN. A porta é realinhada para os 30 ms (histórico de 4 blocos).
- Proteção de CPU: média acima de 5 ms por 10 ms volta para o RNNoise e registra no log.
- Configuração `noiseSuppressionMode` (`high` por padrão, `standard`). Em "Voz e vídeo" aparece "Alta qualidade" / "Padrão" sob o switch, desabilitado se a DLL não veio na instalação.
- Pedido adicional do usuário: slider "Intensidade da supressão de ruído", de 0 a 100%, nos dois modos. `noiseSuppressionStrength` é inteiro, persiste em QSettings e chega à thread de áudio via VoiceService/VoiceCall/VoiceDevices. A mistura linear entre o áudio original e o filtrado/porta usa o mesmo bloco temporal (atraso de 10/30 ms), antes do AGC. 0% preserva o original com esse atraso; 100% mantém o filtro completo anterior. O ajuste não reinicia o filtro; intensidades menores deixam passar mais ruído. Não representa uma porcentagem medida de ruído removido, nem reduz CPU. O switch desliga o processamento de supressão.
- `portable-web.ps1` exige a pasta `deepfilter`, e `verify_web_release.py` confere a DLL, o modelo e as licenças. O instalador cresce cerca de 38 MB descomprimidos.

**Testes:**
- `deepFilterKeepsTheGateAligned`: porta + DFN, teclado entre frases cortado, fala bit a bit.
- `deepFilterRemovesTypingWhileTalking`: fala real com teclado o tempo todo. Medido: entrada 5,3 dB, RNNoise 10,2 dB, DFN 18,6 dB, 0,76 ms por 10 ms.
- Os dois pulam (`QSKIP`) sem a DLL ou sem a amostra.
- `suppressionStrengthBlendsAlignedAudio`: original, metade e máximo em RNNoise/DFN; verifica alinhamento por amostra e alteração em execução. `deepFilterRejectsDamagedModel`: processos isolados com modelo ausente/corrompido verificam recuperação sem encerrar o cliente. E2E das configurações testa ajuste nos dois modos, persistência e rejeição de valores inválidos.
- **Observação:** o DFN destrói a voz sintética de formantes (é ruído para um modelo treinado com pessoas). Por isso os E2E, que usam voz sintética no `syntheticProcessor_`, continuam no RNNoise.

### Transmissão: recuperação e captura (0.9.32 local, Codex)

O usuário confirmou prévia preta na própria máquina ao compartilhar janela ou monitor. O log da 0.9.31 mostra conexões de vídeo estabelecidas, mas não registra causa de captura/codificação. Não foi feita reprodução em duas máquinas. Após o pedido explícito de não executar E2E, foram usados compilação e testes unitários, sem abrir clientes para uma chamada.

- `ScreenEncoder` mantém a última textura NV12 própria (não retém superfície WGC), atende PLI mesmo com a fonte estática e repete um quadro por segundo. O relógio monotônico evita misturar timestamps da captura e da recuperação. `ScreenFrameSchedule` preserva PLI com encoder ocupado e respeita FPS.
- `ScreenCall::recover` também solicita IDR ao estar conectado sem renderizar quadros. Antes, conexão ICE saudável fazia a recuperação ignorar ausência de imagem.
- `CoreSession` usa `streamsChanged` para anunciar a tela antes de decodificar; `loading` permite mostrar “Conectando à transmissão…” e o overlay fica oculto até a imagem chegar. Recriar um peer não elimina a transmissão da lista.
- `NativeCapture` tenta GDI se WGC não entrega o primeiro quadro após 2 s. Uma cena totalmente preta não comprova captura quebrada: mantém WGC se GDI também devolve preto, em vez de migrar definitivamente para um método igualmente sem imagem. Em erro de API, conserva a recuperação por GDI. Sempre usa a fonte selecionada.
- `CaptureGpuPreview` define estado de blend/escrita, layout e shaders de geometria/tesselação. Isso remove dependência de estado implícito de um dispositivo também usado pelo Media Foundation. Teste com textura artificial e máscara de escrita zerada verifica as cores após contaminação do contexto; não reproduz o problema específico da máquina do amigo.
- Empacotamento mantém checagem estática de arquivos/modelo. `-SkipRuntimeVerification` evita inicializar aplicativos em validação e registra `runtimeVerified=false`; o padrão continua exigindo validação de execução.
