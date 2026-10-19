# Escopo aprovado do Triscord desktop

> Atualização de 14/10/2026: o usuário revogou as preferências/regras anteriores de produto e arquitetura. A meta atual é reproduzir a interface do Discord por engenharia reversa, com tema preto; a única restrição de produto mantida é gratuidade. A arquitetura é livre. Leia ../ORQUESTRACAO_ANTIGRAVITY.md. As listas abaixo são históricas, não uma lista atual de exclusões obrigatórias.

Decisões do usuário para a branch `rewrite/native-desktop`. A versão nativa
continua uma prévia de salas/chat, voz e tela experimentais; a lista de manter define os recursos a portar,
não funcionalidades já concluídas. A versão estável na `main` fica preservada.

## Removidos / excluídos da reescrita

- Gravação local de chamadas e composição de vídeo para gravação.
- Envio, colagem/importação e visualização de imagens anexadas ao chat. O servidor
  ignora campos de anexos de clientes antigos e rejeita mensagens só com imagem.
- Tema claro, inclusive preferência antiga; o cliente usa apenas tema escuro.
- Animações e transições decorativas. Indicadores de fala continuam funcionais.
- Versão web: não servir o renderer por HTTP. Manter `/` como health check JSON.
- Diagnóstico integrado, indicadores de CPU/RAM/GPU e histórico de métricas.
  Ferramentas de engenharia ficam fora do executável distribuído.

## Manter

- Voz, mute/deafen, cancelamento de eco e seleção de dispositivos.
- Webcam com desfoque e imagens de fundo. A remoção de imagens no chat não
  remove o upload de imagem para o fundo da webcam.
- Tela/janela com áudio do sistema; uma tela em foco, demais em qualidade reduzida.
- Soundboard com importação de arquivos de áudio, sincronização, volume e mute.
- Chat de texto e histórico de até 200 mensagens por sala; reações com emojis.
- Sons de notificação e notificações do Windows.
- Indicador de fala, nome/cor de avatar e status personalizado.
- Teste de microfone ativado pelo usuário e supressão de ruído.
- Push-to-talk e atalho global de mute.
- Criação de salas e controles do dono: trancar, limitar, expulsar e silenciar.
- Volume/mute individual de pessoas e transmissões.
- Zoom, foco e tela cheia.
- Atualizações automáticas.
- TURN, negociação WebRTC e recuperação de conexões.

## Limites de desempenho e infraestrutura

Cobrança zero; mídia direta como base e LiveKit Build limitado, sem upgrade
automático. A lógica de adaptação pode ler estatísticas transitórias necessárias
à operação, sem painéis de diagnóstico ou coleta periódica de recursos do PC.
Perfis alvo: movimento em 720p60 e texto em 1080p30, com redução automática.
