# Referências da interface

Pesquisa em 13/10/2026. As referências orientam organização e hierarquia; os desenhos e recursos visuais não são copiados.

- [Discord Redesign — DPI_MEDIA](https://dribbble.com/shots/26639461-Discord-Redesign): é a imagem enviada pelo usuário. Referência principal para três colunas, controles compactos, avatares e contraste entre superfícies.
- [Discord Redesign — Pim Scholten](https://dribbble.com/shots/6645847-Discord-Redesign): navegação de canais e separação entre conversa e presença.
- [Discord — Alfredo Chico](https://alfredochico.com/projects/discord): estudo de navegação e descoberta de funções, com iterações sobre densidade e espaço disponível.
- [Compartilhamento de tela — Discord](https://support.discord.com/hc/en-us/articles/360040816151-Go-Live-and-Screen-Share): separação entre compartilhar uma janela e uma tela inteira.

## Aplicação no triscord

- Fundo AMOLED preto, superfícies discretas em cinza, textos em minúsculas.
- Salas à esquerda, conversa e chamada no centro, lista de participantes à direita.
- Cartões dos participantes com avatar, nome e estado do áudio, atualizados por eventos. A borda fica branca durante atividade de voz; há 300 ms de tolerância para pequenas pausas. Não representam webcam.
- Seletor de compartilhamento com abas `telas inteiras` e `janelas de programas`, seleção explícita e botão de confirmação. Miniaturas reais são capturadas uma vez, sequencialmente, com no máximo uma captura ativa. Fontes indisponíveis conservam o ícone de categoria.
- A opção de compartilhar áudio do PC é desligada por padrão. WASAPI captura outros aplicativos e exclui o triscord e seus processos filhos, evitando retransmissão das vozes da chamada. Em uma janela, a opção continua compartilhando o áudio do PC inteiro, conforme o rótulo.
- As fontes são enumeradas ao abrir o seletor ou clicar em atualizar. Não há capturas permanentes para alimentar o seletor.
- A captura nativa seleciona janelas e monitores. Abas individuais de navegador não são fontes independentes; para isso, o usuário precisa abrir a aba em uma janela separada.
- Sem adicionar navegador, animações decorativas, mídia no chat ou funções removidas anteriormente.

Os cartões, indicador de fala e seletor são nativos. Tratamento das mensagens e controles com ícones podem receber melhorias posteriores.

- Soundboard nativo com 32 sons recuperados do perfil antigo, busca, volume e reprodução sob demanda. Apenas o identificador é enviado à sala; áudio e navegador não são necessários no servidor.
- Transmissão própria e remota ocupam a mesma área principal. Divisórias arrastáveis permitem redimensionar as colunas e a divisão entre vídeo e chat, com tamanhos salvos.
- Exclusão das próprias mensagens pelo menu de contexto, sincronizada com a sala e removida do histórico.
