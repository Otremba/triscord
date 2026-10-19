# Auditoria visual Discord × Triscord — 18/10/2026 (Claude Code)

Pedido do usuário: rever a interface inteira, comparando capturas do Discord e do Triscord, e copiar o que estiver diferente. O ícone deveria ficar nas cores da splash.

## Método
- **Discord:** o app instalado, no estado real do usuário. Ele estava sozinho em "Geral" do "Servidor de camargo", com o microfone mudo; isso não foi alterado. Só se abriram menus, popovers e as Configurações, sempre fechados com Esc. Nada foi enviado, criado ou salvo.
- **Triscord:** o build de desenvolvimento, numa sessão de auditoria (`tests/e2e/visual_audit_session.py`).
  - Backend local, conta "camargo" e "Servidor de camargo".
  - O WebView2 com depuração remota, controlado por `web/tools/audit-drive.mjs`. As telas são trocadas por JS e a página é capturada pelo CDP (o PrintWindow do WebView2 sai velho quando a janela não está na frente).
- **Mesmo tamanho:** a janela do Discord tem 8 px de borda invisível à esquerda, à direita e embaixo. As duas áreas comparadas são 1264×892, com o Triscord no tema do Discord do usuário ("Cinza", `theme-dark`).
- **Evidência de CSS:** o cache atual do Discord, lido com `out/rea-claude-20261016/blockfile.cjs` (só leitura).

## Diferenças encontradas e corrigidas
| Tela | Discord | Triscord antes | Agora |
|---|---|---|---|
| Ícone do app | — | glifo branco sobre quadrado preto | glifo branco sobre `#282b30` (a cor da splash), cantos arredondados: `assets/triscord-app.ico` no exe, no lançador e no instalador |
| Cabeçalho do servidor | nome + seta, que abre um dropdown de 220 px centrado 4 px abaixo, com ícones à esquerda; a seta vira para cima | só o nome | botão com seta e dropdown: "Convidar para o servidor" (dono), "Criar canal" e "Sair do servidor" (membro) |
| Menus | sem anel de foco | anel branco do navegador quando o menu recebia foco depois de uma tecla | `outline: none` no menu e em foco programático |
| Lista de voz | mudo próprio em cinza; vermelho só para silenciado no servidor | mudo próprio em vermelho | cinza (vermelho só no servidor) |
| Lista de voz | sem a linha "Convidar para voz" (hoje) | tinha a linha | removida |
| Ordem dos canais | fixa | "Jogos" subia acima de "Geral" ao entrar (o hub lista na ordem do mapa, que muda ao salvar a sala) | o núcleo guarda a ordem da primeira vez que viu cada sala |
| Botões do painel de voz | `_e131a9`: `--control-secondary-*`, borda `--border-muted`, ícone branco; ligado em `--opacity-green-12` com ícone `--green-new-30` | ícones cinza; verde sólido quando ligado | conforme o CSS |
| "Voz conectada" | text-md/semibold (16 px) | 14 px | 16 px |
| Microfone mudo | `__67645 .redGlow`: `--opacity-red-12` (24 no hover) no botão e na seta, ícone `--status-danger` | só o ícone, salmão | cápsula vermelha como no Discord |
| Menu do próprio usuário | Perfil / Silenciar ☑ / Desativar áudio ☐ / … / Silenciar voz no servidor | "Ver perfil", "Silenciar voz na sala" | "Perfil", "Silenciar" e "Desativar áudio" (os seus), "Silenciar voz no servidor" |
| Menu do canal | …, Editar canal, Duplicar canal, Criar canal de voz, Excluir canal | sem "Duplicar canal" | "Duplicar canal" (cria uma sala de mesmo nome) |
| Cartão da conta | 300 px, à esquerda do painel, logo acima da linha do usuário; avatar de 80 px com status; balão de fala com "+" e "Qual a sua obsessão atualmente?"; ações em cartões com ícones | pílula "Adicionar status", ações em texto solto, anel de foco no balão | no layout do Discord: balão com "+" e bolinhas, ponto de status, cartões ("Editar perfil" com lápis; "Sair da conta" onde o Discord tem "Mudar de conta"), foco sem anel |
| Rolagem | `d125d2` "auto": 16 px com borda transparente de 4 px, `--scrollbar-auto-*` | barra do Windows com setas | estilo do Discord, global |
| Seleção de dispositivo | "Padrão do Windows (MCHOSE V9 P…)", com o nome em cinza | só "Padrão do Windows" | com o nome do padrão (`isDefault` vindo do núcleo) |

## Diferenças que continuam (sem função no Triscord ou fora desta rodada)
- **Barra de título:** setas voltar/avançar e os ícones de caixa de entrada, ajuda e DevTools.
- **Rail:** botão do Discord (mensagens diretas) e "Explorar".
- **Lateral:** "Eventos", "Impulsos de servidor", canais de texto e a linha "Definir um status do canal" sob o canal conectado.
- **Painel de voz:** o botão de supressão de ruído (onda sonora) e o de atividades.
- **Chamada:** o cartão de atividades ("Convidar para voz" / "Escolher atividade") quando você está sozinho.
- **Cartão da conta:** a linha de presença (Invisível/Disponível) com submenu, Orbs e "Mudar de conta".
- **Menus:** itens sem função ("Marcar como lida", "Silenciar servidor", "Config. de notificação", "Mover para…", "Editar canal", "Excluir canal" — o hub não tem exclusão nem renomeação de sala —, "Mencionar", "Apps", "Abrir na visualização de moderador", "Desativar áudio no servidor").
- **Configurações:** "Teste do microfone", "Perfil de entrada" e as demais páginas.
- **Telas ainda não comparadas nesta rodada:** soundboard, modais (criar canal, criar servidor, convite), menus de áudio, controles e cabeçalho da chamada, chat, editor de perfil, outras páginas das Configurações e tooltips.
- **Tema:** o Discord do usuário está em "Cinza" (`theme-dark`); o padrão do Discord para conta nova, adotado pelo Triscord, é "Escuro" (`theme-darker`).

## Testes
- CTest 12/12.
- E2E da área:
  - moderação 35/35 (o teste navega pelo teclado e agora passa por "Silenciar" e "Desativar áudio");
  - participante 21/21, menu do vídeo 5/5, conta 22/22, configurações 8/8 e servidores 15/15.
- Pacote 44/44.

## Entrega
- Área de Trabalho:
  - `Triscord.exe` portátil `29A1527A…` (backup A512AB9F);
  - `Triscord-Setup-0.9.22.exe` `4bb5f65e…`.
- Capturas: só locais (`scratchpad/audit`); elas trazem dados do usuário.

## 2ª rodada (18/10): soundboard, menus de áudio, modais, chamada e chat

Mesmo método. No Discord só se abriram painéis e menus, fechados com Esc. Nenhum som foi tocado e nada foi criado nem digitado. No fim, o Discord ficou como estava: na chamada, mudo e com o chat fechado.

| Tela | Discord | Triscord antes | Agora |
|---|---|---|---|
| Soundboard | 532 px, busca, seções | igual em tamanho e estrutura | sem mudança |
| Menu do microfone ou do fone | alinhado à esquerda do botão de áudio; "Configurações de voz" com a engrenagem antes do texto | alinhado à seta (33 px à direita); engrenagem depois | alinhado ao botão; engrenagem antes |
| Criar canal | campo de nome focado, com borda da marca | igual, sem mudança perceptível | sem mudança |
| Criar seu servidor | "Criar o meu" e a lista de modelos | sem modelos | sem mudança (modelos sem função) |
| Barra da chamada | cápsulas `.buttonSection_a83780`: `--background-mod-subtle` sobre o preto, `--border-muted`, raio 12, padding 4, 12 px entre grupos | cápsulas cinza (`--background-surface-high`, `--border-subtle`), 14 px | conforme o CSS |
| Barra da chamada | seta na câmera ("Câmera" com o dispositivo, "Prévia da câmera", "Configurações de vídeo"); "…" no segundo grupo | sem a seta e sem "…" | seta com "Câmera" (submenu de dispositivos, com o atual como subtítulo) e "Configurações de vídeo"; "…" com "Convidar para voz" (dono), "Mostrar participantes sem vídeo" (preferência local que filtra os cartões) e "Configurações de voz e vídeo" |
| Pop-out | o botão aparece mesmo sozinho e sem vídeo | só com vídeo (regra antiga do bundle) | sempre; o E2E da pop-out foi atualizado |
| Chat da chamada | 450 px; no topo do histórico: círculo de 68 px com balão de 36 px, "Bem-vindo(a) a Geral!" (32 px extrabold) e "Este é o começo do canal Geral." (16 px), além de "Editar canal" | painel vazio | as boas-vindas, sem "Editar canal" |
| Menus | itens com segunda linha (12 px, `--text-muted`) | sem suporte | `subtext` no `ContextMenu` |

**Regressão encontrada e corrigida:** o `applicationDisplayName("Triscord")` da Fase 15 fazia o Qt acrescentar " - Triscord" a todo título de janela. A pop-out deixou de se chamar só pelo canal, e o E2E dela não a encontrava. A linha foi removida: o nome da barra de tarefas vem do `VERSIONINFO`.

**Ainda diferente:**
- campo do chat sem "+" (anexos) e sem os botões de emoji e apps;
- menu da câmera sem "Prévia da câmera";
- "…" sem "Exibição em grade", "Mostrar Minha Própria Câmera" e "Mostrar prévia de novas mensagens";
- soundboard sem o aviso do Nitro, "Utilizados com frequência", "Sons do Discord", a dica de atalho e o botão de volume ao lado da busca;
- medidor "Nível de entrada" e "Perfil de entrada" no menu do microfone;
- modelos de servidor;
- o modal de convite não foi recapturado, porque abri-lo no Discord cria um convite.

**Testes:**
- CTest 12/12.
- E2E: visão da chamada 29/29, pop-out 17/17, menus de áudio 8/8, chat 11/11 e visão ampliada 13/13.
- Pacote 44/44.

**Entrega:**
- Área de Trabalho: `Triscord.exe` `76117E4E…` (backup 29A1527A) e `Triscord-Setup-0.9.22.exe` `13fdfc45…`.

## Atualização Codex — 18/10/2026 — Prévia local (0.9.25)

A pendência de prévia da câmera passou a ter implementação: menu da câmera → Prévia da câmera e Configurações → Voz e vídeo → Câmera → Testar vídeo. A prévia usa captura nativa local sem publicar para a sala; quando já existe transmissão, reutiliza seus quadros locais e preserva a transmissão ao fechar. Configurações também passaram a abrir na janela destacada. Evidência REA, limites visuais e funcionamento em desktop/CAMERA_PREVIA_20261018.md. Passaram 23 verificações da prévia e 8 das configurações; webcam física e WAN continuam pendentes. O modal da prévia não foi observado no Discord: não declarar equivalência visual completa desse estado.
