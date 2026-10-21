# Mapa de aplicação do redesign

Inspeção estática do checkout em 21/10/2026. Este mapa prepara a aplicação da direção visual após a avaliação da revisão 02; não declara paridade funcional, visual ou execução validada.

## Superfícies e contratos a preservar

| Superfície | Fonte existente | Preservação necessária |
| --- | --- | --- |
| Janela e estrutura | `desktop/web/src/App.tsx`, `TitleBar.tsx` | Arraste/redimensionamento, tela cheia, hosts de menus/modais, eventos de perfil e configurações; não reimplementar IPC |
| Espaços / servidores | `ServerRail.tsx`, `ServerModal.tsx`, `InviteModal.tsx`, `ServerRemovalModal.tsx` | Selecionar, criar, aceitar/gerar convite, sair e excluir conforme permissões; menu de contexto e feedback de erros |
| Canais e participantes em voz | `ChannelSidebar.tsx` | Seleção de texto separada da entrada em voz; categorias, criação de canal, identidade de conta/socket e estado real de fala |
| Conversa e chamada | `ChannelView.tsx` | Seleção de canal, lista de membros, abertura do chat durante chamada, foco de vídeo e popout quando disponível |
| Chamada | `CallView.tsx`, `AccountPanel.tsx` | Mute, deafen, menus de dispositivos, desconectar, foco/filmstrip, tela cheia e ações de mídia suportadas |
| Vídeo nativo | `VideoTile.tsx`, `video.ts` | `ResizeObserver`, `videoSurface`, `videoRole`, remoção da superfície, suspensão por modais e recorte de menus; CSS não pode encobrir controles com janelas nativas |
| Mensagens | `ChatPanel.tsx`, `Markdown.tsx`, `DeleteMessageModal.tsx` | Histórico, agrupamento, rascunho, rate limit, resposta, reação, cópia, exclusão própria e acessibilidade do composer |
| Pessoas / perfil | `MemberList.tsx`, `ParticipantProfile.tsx`, `ProfileEditor.tsx`, `PeerAudio.tsx` | Menus do participante, carregamento/erro, mídia de perfil, formulários, upload em blocos e preferências individuais |
| Entrada / conta | `LoginScreen.tsx`, `AccountPopover.tsx` | Google/nome/senha, apelido inicial, erro sem perder entrada, status da conta e logout |
| Configurações | `Settings.tsx`, `AudioMenu.tsx` | Mesmas chaves e valores existentes, lista real de dispositivos, recursos indisponíveis explicitados |
| Mídia opcional | `SharePicker.tsx`, `CameraPreview.tsx`, `Soundboard.tsx` | `runtime.camera`, `runtime.screenAudio`, `runtime.soundboard` e demais capacidades; não transformar a imagem conceitual em promessa de recurso implementado |
| Sobreposições e avisos | `ModalLayer.tsx`, `ContextMenu.tsx`, `Tooltip.tsx`, `NoticeToast.tsx` | Escape, fechar camada superior, restauração/foco, tooltips e erros acessíveis; avisos de chamada não podem depender só de toast temporário |

## Substituições visuais previstas

- Substituir a coluna de círculos da proposta inicial por navegação de espaços integrada, preservando acesso a todos os servidores e ao início. Na imagem, os espaços recentes são ilustrativos; na aplicação devem vir da sessão real e ter acesso à lista completa.
- `TriscordLogo`: passar do gradiente/brilho para marca plana. Não adicionar download de fonte ou biblioteca de ícones para isso.
- `ShimmerButton`: migrar para botão de ação estável, com variantes primária, secundária e destrutiva e foco visível; preservar `type`, `form`, `disabled`, eventos e conteúdo.
- `AudioRipple`: substituir ondas permanentes por contorno/estado de fala discreto, derivado de `speaking`.
- `AudioEqualizer`: não usar barras fictícias para indicar conexão. O painel existente tinha `active={true}` independentemente de áudio; esse uso já foi removido.
- Spotlight em cada mensagem: retirar acompanhamento de mouse e a iluminação radial, preservando hover/foco das ações.
- `FloatingDock` e `BentoCard`: aproveitar agrupamento e hierarquia quando úteis, com superfícies sólidas, sem blur, salto no hover ou brilho.
- `BorderBeam`: não incluir na nova tela principal. Remover código sem uso somente após confirmar referências e migração.
- Manter ícones do conjunto existente durante a migração. A proposta gráfica usa desenhos simples e não substitui o catálogo real.

## Evidência encontrada e ação independente concluída

`AccountPanel.tsx` apresentava sempre “Voz conectada”/“Vídeo conectado” e um equalizador em movimento sempre que havia um canal. O núcleo já fornece `voiceState` (`idle`, `connecting`, `connected`, `reconnecting`, `error`); o estado do WebSocket de controle não comprova conexão do áudio.

A correção `f3257c3` passa a usar essa informação e anuncia o estado com `role=status`, removendo o equalizador fictício do painel. Snapshots legados sem `voiceState` mantêm o fallback existente. Não muda dispositivos, sessão ou protocolo.

Validação desta correção: TypeScript sem erros e teste Node puro da tabela de estados, incluindo controle conectado com voz ainda conectando, controle reconectando com voz conectada e compatibilidade de snapshots legados. Comando: `node desktop/web/tools/test-call-status.mjs`. Nenhuma execução de aplicativo ou áudio.

## Critérios para a implementação após o refinamento

1. Todas as superfícies acima devem seguir os mesmos tokens, tipografia, espaçamento, foco e estados; não basta aplicar uma folha de override ao layout antigo.
2. O estado da mídia deve continuar separado do controle; controles de capacidades ausentes permanecem ocultos ou explicitamente indisponíveis.
3. Canais/contas, atalhos e fluxos existentes não podem perder funcionalidade em troca do novo layout.
4. Sem animação permanente de decoração; transições pontuais ficam desativadas com movimento reduzido. Indicadores de carregamento devem ter alternativa textual.
5. Rodar TypeScript, unidades e build sequenciais pertinentes. Não executar Playwright/Edge/E2E nem abrir aplicativo para validar: as instruções atuais proíbem automação de interface, mesmo headless.
6. Até haver validação permitida da interface real, registrar a limitação e não chamar a imagem desenhada de screenshot, regressão visual ou prova de desempenho.

O objetivo completo permanece em andamento; o mapa não substitui a implementação ou a avaliação do usuário.
