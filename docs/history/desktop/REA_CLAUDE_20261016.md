# Engenharia reversa (REA) — rodada do Claude Code, 16/10/2026

Complementa `REA_APROFUNDAMENTO_20261016.md` (Codex: qualidade de tela, PiP, enumeração de captura). Esta rodada cobriu o **núcleo que eu tinha implementado com partes inferidas**: entrar em servidor, criar servidor, editar avatar/faixa e tema de perfil. Tudo estático: nada do Discord foi executado e nenhuma janela foi aberta (o usuário estava jogando). Os processos rodaram em prioridade Idle, com 1 núcleo.

Evidências em `out/rea-claude-20261016/` (pasta ignorada pelo git): os assets com `SHA256SUMS.txt`, a Evidence do REA, o trace, o índice do cache e o leitor do cache.

## Como o material foi obtido

1. A decodificação anterior (`f_XXXXXX` do cache, 15/10 20:41) **não continha** o fluxo de servidor. O fluxo foi aberto no Discord em 16/10, mas os chunks pequenos ficam **dentro** dos blocos `data_1..3` do cache do Chromium, que o decodificador antigo não lia.
2. Escrevi um leitor só de leitura do formato *blockfile* do Chromium (`blockfile.cjs`). Ele percorre `EntryStore` em `data_1`, segue `data_addr[1]` usando o tamanho de bloco do cabeçalho de cada `data_N` e descomprime o corpo. Resultado: **4.002 entradas**, sendo 3.733 brotli, 102 gzip e 167 cruas; 2.667 delas são JS. O índice com URL e SHA-256 está em `blocks-index.json`.
   - A primeira versão usava o tipo do endereço para deduzir o tamanho de bloco, o que estava errado: só 187 corpos saíram decodificados. Corrigi lendo `entry_size` do cabeçalho. O erro fica registrado aqui e não foi usado como evidência.
3. **REA `analyze-javascript-application`** (CLI `C:/Users/camargo/Documents/GitHub/rea/scripts/rea.mjs`, heap de 128 MiB, 15 s por fonte) sobre os 4 chunks do fluxo de servidor:
   - **Evidence `ev_f85e89975ce532921d5aab85eb0beca9111ca06655958f345278e4a442d4e977`**: 4 arquivos, 22 módulos, 13.129 nós AST, 0 falhas de parse.
4. **REA `trace-javascript-semantics`**, semente `property 7jub2t`, `backward-provenance`:
   - **Evidence `ev_8699ed2498121ac1849d2e3cde66dbb7345da984445d6f93c4da739af1429133`**, status `partial`: 1 nó e 0 relações.
   - O grafo semântico não segue a cadeia JSX minificada. Por isso a leitura do componente foi feita direto no texto do módulo, que é inerte. Isso **não** prova ausência de relações.

## Achados

| Pergunta | Fonte (asset, SHA-256) | Situação |
|---|---|---|
| Tela "Entrar em um servidor" | `assets/4be9909f40fba94b.js` `e29aa67d…`, módulo 812633, componente `H` (slide `JOIN_GUILD`); CSS `assets/2d1f7e43168351af.css` `580c7254…` (classes `*__991a0`); mapa de classes no módulo 479043, em `assets/9d78e883f5732170.js` `727709cb…` | **Respondida (código + CSS)** |
| Ordem dos passos do fluxo | mesmo módulo 812633, componente `V` | Respondida |
| Passo "Personalize o seu servidor" | `assets/42e373fe7727cd0f.js` `616825b1…`, módulo 424912 | Respondida |
| Mudar/remover avatar e faixa no editor novo | cache `f_0000bc` `c7123060…` (e cópia `f_0000de`) | Respondida (textos e tipo de controle) |
| Tema de perfil (duas cores) | CSS `assets/96ee09de752e7ff4.css` `25c547d4…`; módulo de tema em `f_00000a` (`6a1a62d7…`), token `PROFILE_GRADIENT_OVERLAY` | Respondida |
| Tamanho da fonte da sigla no trilho conforme o comprimento | — | **Aberta**: a busca ampla foi interrompida para não pesar no jogo |

### Observado (código e CSS)

- **JOIN_GUILD**:
  - Título `heading-xl/semibold` "Entrar em um servidor" (`riOUtB`). Subtítulo `text-sm/normal` "Insira um convite abaixo para entrar em um servidor existente" (`7jub2t`, **sem ponto final**).
  - Campo obrigatório "Link de convite" (`qreV25`), com placeholder `https://discord.gg/hTKzmak`.
  - "Convites devem ser mais ou menos assim" (`Bnq46H`, `text-sm/medium`, `text-subtle`), seguido de três exemplos clicáveis que **preenchem o campo**: `hTKzmak`, `https://discord.gg/hTKzmak` e `https://discord.gg/wumpus-friends`.
  - Linha "Não tem um convite?" que leva ao Descobrir.
  - Rodapé com **"Entrar no servidor"** (`Ts/9Ac`, primário) e "Voltar" (`13/7kX`).
  - O código usa o último segmento do caminho colado como código do convite.
  - Erros: vazio → "Insira um link de convite ou um código de convite válido." (`IRq5ah`); convite sem canal → "O convite expirou ou não é mais válido." (`GEYI+Z`); outros → "Não foi possível aceitar o convite" (`dDZRdy`).
  - CSS: cabeçalho centralizado; título em negrito com margem 24 em cima e 8 embaixo; X a 12 px do topo e da direita; formulário com 16 px abaixo; exemplos em `inline-block` de 14 px/18 px, padding e margem de 4, raio `--radius-xs` (4 px), fundo `--background-mod-muted`, borda de 1 px `--border-muted`, cor `--text-strong`; rodapé com `justify-content: space-between`.
- **Fluxo**: `GUILD_TEMPLATES → CREATION_INTENT → CUSTOMIZE_GUILD → CHANNEL_PROMPT`, com `JOIN_GUILD` saindo do primeiro passo. "Voltar" em CUSTOMIZE volta para CREATION_INTENT. A largura vem do token `modal.WIDTH_SMALL`.
- **CUSTOMIZE_GUILD**:
  - Nome sugerido por `getGuildNameSuggestion()`, com `maxLength: 100`.
  - Rodapé com "Criar" (`CumH4u`, primário) primeiro e "Voltar" depois (secundário, `size sm`).
  - Erro de campo vindo do servidor em `text-feedback-critical`.
- **Editor de perfil novo**:
  - O bloco do avatar abre um menu com `change-avatar` "Mudar avatar" (`4OynCD`) e `change-decoration` "Mudar decoração de avatar"; em vermelho (`color:"danger"`), `remove-avatar` "Remover avatar" ou `reset-avatar` "Redefinir avatar" no perfil de servidor, e `remove-decoration`.
  - A faixa é um bloco quadrado que abre o diálogo de envio (`aria-haspopup: dialog`). Quando há faixa, aparece o atalho "Remover faixa" (`tT9n7D`).
- **Tema de perfil**:
  - `.custom-user-profile-theme .profile__9c3be` pinta `linear-gradient(primária, primária até --custom-user-profile-banner-height, secundária)`.
  - O `::before` aplica `--profile-gradient-overlay-color` por cima. O módulo de tema resolve essa cor como `BLACK` a 0,6 nos temas DARK, ONYX e ASH, e `WHITE` a 0,6 no LIGHT; a 0,8 quando sincronizado com o tema do usuário.
  - Sem tema, o fundo usa `--background-surface-high`.

### Inferido

- A faixa usa `--custom-user-profile-banner-height` = 140 px no MODAL_V2, porque bate com `bannerHeight: 140` da tabela `MODAL_V2`. O valor da variável não foi lido diretamente.
- Tokens no tema midnight: `--background-mod-muted` = rgba(151,151,159,0,078); `--border-muted` = rgba(151,151,159,0,161); `--text-strong` = `#dcdcdf`; `--text-feedback-critical` = `#eb5f5e` (red-new-37 convertido de HSL).

### Desconhecido

- Visual do JOIN_GUILD capturado na tela (ainda não houve captura; foi reconstruído de código + CSS).
- Tela pós-criação `CHANNEL_PROMPT`.
- Conteúdo dos modelos de servidor.
- Tamanho da sigla no trilho conforme o comprimento.
- Onde aparece "Alterar imagem da faixa" (`W86r+Q`).

## Mudanças no triscord a partir disto (só `desktop/`)

- `src/server_dialog.*`, tela de convite:
  - Subtítulo sem ponto; botão **"Entrar no servidor"**; erros com os três textos reais.
  - Exemplo clicável que preenche o campo, com o estilo dos exemplos do Discord. Mostra um único código, porque o triscord não tem domínio de link de convite.
  - X a 12 px; erro e asterisco em `#eb5f5e`.
  - A linha do Descobrir ficou de fora (não há função no triscord).
- `src/profile_edit_dialog.cpp`: "Enviar imagem" virou **"Mudar avatar"**; "Remover avatar" e "Remover faixa" ficaram em vermelho, como no menu `danger`.
- `src/profile_preview.*`: o tema de perfil passou a seguir a regra real (primária até 140 px, degradê para a secundária, preto a 60% por cima), no lugar do degradê inventado.

## Validação

- Compilado `triscord_ui` + `triscord_auth` em prioridade Idle, 1 núcleo: **ok**. Isso inclui as otimizações de memória do Codex em `profile_media`, que ainda não estavam compiladas.
- Depois do jogo: CTest 12/12; UI 53/53, incluindo `joinServerPageFollowsRecoveredDiscordSlide`; hub/mídia 12/12. Pacote `c75d51ac…` copiado para `Desktop	riscord.exe`. Consumo parado: 93,4 MB físico, 72,0 MB privada, 26 threads, 0 ms de CPU em três janelas de 10 s.
- Defeito encontrado e corrigido nesta validação: o modal de servidor é uma janela translúcida, e o Qt não pinta o fundo do stylesheet nesse caso. As capturas tinham alfa 0, e o modal real teria aparecido transparente. As comparações anteriores esconderam isso porque os PNGs foram colados sobre fundo preto. Agora o fundo é pintado em `paintEvent`, e um teste exige pixel opaco `#0a0a0c`.
