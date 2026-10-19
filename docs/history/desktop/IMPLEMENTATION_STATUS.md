# Etapas da implementação nativa

Branch: `rewrite/native-desktop`. A `main` e o canal de distribuição estável
permanecem separados. Esta prévia ainda não substitui o cliente estável.

Estado atual: **0.9.21**, voz, tela e câmera integradas às salas; Worker publicado no Free.
Pacote único para o grupo, sem configuração manual de servidor/convite.
Interface da chamada reconstruída a partir das evidências REA: cartões com
nomes no canto inferior esquerdo, borda branca ao falar e área de participantes
redimensionável, além das divisórias existentes de tela/chat e colunas laterais.
A grade agora usa o cálculo recuperado do componente de chamada do Discord:
tamanho dos cartões e número de colunas dependem da largura e altura disponíveis.
Duplo clique abre a transmissão clicada; zoom permanece durante novos quadros.
Duas transmissões podem ter suas larguras ajustadas pela divisória, com preferência salva.
Controles de áudio, mídia e ações separados; a barra muda de linha quando necessário.
Seleção da transmissão e ações de visualização não cortam rótulos na janela estreita.
Chat com autor, horário, avatar circular e texto separado, com quebra de linhas;
reconstrução baseada nos componentes e estilos recuperados, sem widgets por mensagem.
Mensagens comuns do mesmo autor compartilham o cabeçalho até o limite de sete minutos
do início do grupo, sem atravessar mudança de dia; exclusões recompõem os grupos.
Separadores de data na primeira mensagem e ao mudar o dia, sem alterar o limite
de 200 mensagens ou criar widgets/temporizadores adicionais.
Efeitos de fundo ainda são componentes de desenvolvimento, sem integração ao
cliente distribuído. Teste com webcam física e com um amigo pela internet pendentes.
Veja as pendências e os testes ao final; os registros anteriores descrevem
o estado de cada etapa na época de sua implementação.

## Etapa concluída: primeira chamada de voz nativa

- C++20 / Qt Widgets, salas e chat pelo protocolo atual do servidor Node.
- Microfone e saída de áudio nativos via Qt Multimedia, 48 kHz PCM.
- Opus mono, alvo de 32 kbps, quadros de 20 ms, codificação única por quadro.
- Transporte ICE/DTLS-SRTP com libdatachannel e MbedTLS compilados da fonte.
- Um canal por participante remoto, até dez participantes no total.
- Filas limitadas, ordenação por timestamp RTP, descarte de pacotes atrasados
  e ocultação de perdas com Opus. Sem histórico de métricas.
- Mute/deafen e início com microfone silenciado, descarte de sessões antigas,
  tentativas limitadas de recuperação de conexão.
- Ferramentas de teste separadas; pacote contém somente o cliente, bibliotecas
  de execução e metadados de licença. Sem diagnóstico integrado.

Validação local em 12/10/2026: compilação Windows/MinGW e pacote aprovados;
duas suítes CTest (núcleo e voz), incluindo seis casos de voz; integração de
salas/chat e voz sintética com 2, 3 e 10 clientes; saída/reentrada com nova
sessão no cenário de três clientes; política de recursos removidos; 40 testes
existentes do servidor aprovados. Os testes exigem áudio decodificado recebido
de todos os outros participantes, não apenas conexão estabelecida.

Isso comprova a cadeia de sinalização/transporte/codec em uma máquina. Não
comprova qualidade de microfone, latência na internet, consumo em jogos ou
funcionamento de TURN em redes restritas. A voz é experimental e funciona
entre clientes nativos; compatibilidade com o cliente Electron não foi aceita.

## Etapa concluída: isolamento da mídia e dispositivos (0.3.0)

Avanço na confiabilidade da voz: uma thread de mídia agora executa captura,
codificação, reprodução, jitter e operações dos pares. O WebSocket continua em
sua thread original, com eventos enfileirados entre as duas. Não há cópia de PCM
para a interface em produção. O recebimento tem fila limitada antes do despacho.

A interface permite escolher microfone e saída, preserva as escolhas e oferece
o padrão do Windows. Alterações de dispositivos são tratadas por eventos com
debounce; falhas de áudio preservam a sala e o chat. A lógica de reconexão física
está implementada, mas retirar/recolocar aparelhos ainda precisa de teste manual.

Validação desta etapa: sete casos de voz, incluindo continuidade do áudio durante
bloqueio da thread da interface na entrega entre pares; integração com 2, 3 e 10 clientes usando threads
de mídia separadas e reentrada com nova sessão; dispositivos locais abertos com
microfone silenciado, deafen/resume, rejeição de escolha indisponível e recuperação
ao escolher o padrão do Windows. Essa verificação de hardware é um
executável exclusivo de desenvolvimento; não grava nem transmite áudio e não
mede qualidade de fala. Compilação e verificação do pacote continuam obrigatórias.

## Etapa concluída: processamento da voz (0.4.0)

- Conversão contínua de PCM nativo de 8 a 192 kHz para Opus a 48 kHz e conversão
  de saída no sentido inverso. Downmix de até oito canais; Float, Int32, Int16
  e UInt8. Não há requisito de o dispositivo expor diretamente 48 kHz.
- Supressão de ruído opcional, ligada por padrão; redução de eco experimental,
  desligada por padrão. Preferências salvas e alterações na thread de mídia.
- Referência do eco derivada da mistura realmente enviada à saída; referência e
  estado do efeito são reiniciados ao trocar dispositivo, mutar ou ensurdecer. Leituras
  parciais de captura são acumuladas e escritas parciais de saída preservadas.
- SpeexDSP compilado da fonte com revisão fixa, sem gravação, sondas, relatórios
  nem opções de dump no cliente. Benchmark em executável de desenvolvimento.

Os testes agora incluem doze casos de voz: conversão PCM, preservação de tom e
continuidade em blocos, rejeição de aliasing, supressão de ruído estacionário e
aprendizagem de eco com atraso sintético, além dos anteriores. Integração com
2, 3 e 10 clientes e reconexão permanece aprovada. Abertura de dispositivos
locais silenciados e recuperação de escolha indisponível também passaram.

Benchmark isolado no Ryzen 5 5600X: média de 0,145 ms por quadro para ruído +
Opus; 0,257 ms para ruído + eco + Opus, com p95 de 0,332 ms. Cada quadro representa
20 ms de áudio; foram 5.000 quadros medidos por opção após aquecimento. Dados em
`benchmarks/voice-processing-2026-10-12.json`. Isso não mede consumo/latência do
aplicativo completo, conversão de taxa, rede ou qualidade de fala real.

A redução de eco precisa de aceitação física: filas de dispositivos, clock
independente e mudanças de latência podem impedir cancelamento efetivo. Não há
garantia de eliminar eco em alto-falantes; fones continuam recomendados no teste.

## Registro das etapas anteriores (0.5.0)

Avanço em tela na versão 0.5.0: captura nativa com Windows Graphics Capture,
seleção explícita de janela/monitor e prévia local. A captura usa thread própria;
a GPU reduz a imagem para até 640×360 antes da cópia para CPU, com aproximadamente
15 quadros de prévia por segundo e uma única imagem pendente para a interface.
Dois buffers no pool, timestamps nativos e gerações por fonte evitam histórico
de vídeo e descarte incorreto ao trocar/parar a captura.

Validado no hardware local com uma janela controlada: quadros reais e cores,
redimensionamento, minimizar/restaurar, parar/reiniciar e fechar a fonte. Quatro
testes CTest de captura verificam limites, produtor concorrente, quadro mais
recente e rejeição de gerações antigas. Voz, salas/chat e reconexão continuam
validados com 2, 3 e 10 clientes. Ferramentas de captura ficam no desenvolvimento.

Na etapa 0.5.0, a prévia não era enviada à sala. Integração da codificação, transporte/recepção
de vídeo e áudio do sistema continuam pendentes. O teste de captura não captura outros apps
nem monitores; configurações de vários GPUs/monitores, HDR, conteúdo protegido
e sessões remotas/bloqueadas ainda precisam de aceitação. Captura SDR requer
Windows 10 1903 ou superior. Não há benchmark do cliente em compartilhamento.

Etapa seguinte implementada como módulo separado `triscord_video`: H.264 via
Media Foundation, seleção de hardware com caminho de compatibilidade por CPU,
eventos assíncronos, entrada limitada a quatro quadros em processamento e saída
limitada por chamada. Há suporte a entrada NV12 por memória e, com codificador
compatível, por textura D3D11. Decodificação NV12 trata padding; timestamps,
dimensões e alocações são limitados. SPS/PPS acompanham IDR para permitir entrada
de um novo receptor, com pedido explícito de quadro-chave.

Teste local aprovado: software e hardware com entrada por memória, hardware
com texturas NV12 sintéticas e reinício em 638×358. Trinta quadros foram codificados
em cada cenário; software decodificou trinta e hardware vinte e nove durante
o teste contínuo (último quadro pode ficar pendente). Imagens variáveis, crominância,
timestamps e receptor criado somente após novo IDR foram verificados. Os testes
ficam em `triscord-video-smoke`, fora do pacote; a variante por software integra
CTest. Isso não é um benchmark de latência nem uma aceitação de envio pela rede.

Nova etapa: `triscord_screen` conecta WGC à conversão BGRA→NV12 e redução de
resolução no processador de vídeo D3D11, seguida do codificador H.264 por hardware.
O vídeo conserva proporção com bordas pretas e sinalização de cor SDR BT.709.
Quando o codificador está ocupado, a conversão é descartada; não há fila extra.
Timestamps da captura são normalizados por sessão. Fonte fechada, oculta ou
indisponível é rejeitada; minimizar pausa a captura sem perder a sessão.

Teste real `triscord-screen-smoke`: uma janela própria de 1280×720 foi capturada,
convertida/reduzida na GPU, codificada e decodificada em 640×360. Valores de
luminância/crominância foram verificados para vermelho, azul e verde. Resize,
bordas, timestamps, novo receptor após IDR, minimizar/restaurar, reinício e
fechamento da fonte integram a aceitação local. Nenhum monitor/outro aplicativo
é capturado e nenhum vídeo é salvo ou enviado. O teste roda fora do cliente,
em thread de trabalho; não integra o CI por exigir sessão gráfica e hardware.

Naquela etapa, o cliente permanecia na versão 0.5.0, sem codificador ativo enquanto mostra a
prévia. Falta ligar o módulo ao compartilhamento e apresentação do
vídeo recebido. A imagem grande do emissor permanece na GPU; a prévia pequena
ainda passa por CPU, e o decodificador do teste usa o caminho de compatibilidade
por CPU. Não há alegação de latência ou redução de consumo comprovada.
Esta composição requer conversão e codificador de hardware compatíveis; fallback
de captura por software e HDR/múltiplos GPUs permanecem pendentes. Texturas
NV12 são novas e imutáveis enquanto pertencem ao MF; reciclagem por pool com
liberação rastreada permanece uma otimização futura.

Etapa de transporte implementada: `triscord_video_transport`, com H.264 sobre
ICE/DTLS-SRTP, fragmentação RTP e relatórios RTCP. PLI/FIR acionam novo IDR, com
coalescência/limite de 250 ms. A remontagem é limitada a um quadro de até 2 MiB,
2.048 pacotes e 200 ms, validando extensões, padding, STAP-A e FU-A, reordenação
interna e wrap. Perda/incompletude e excesso descartam o quadro e exigem SPS/PPS
e IDR; não se entrega fragmento incompleto ao decodificador. A passagem entre
threads permite dois quadros e uma notificação Qt. Overflow pede recuperação;
o decodificador é reiniciado uma vez por ciclo. O emissor deixa de enviar ao
acumular mais de 256 KiB de buffer e volta somente com quadro-chave.

Validação: dez casos de remontagem/clock no CTest e dois peers locais trocando
vídeo nos dois sentidos, com padrões decodificados, FU-A, PLI real e novo
decodificador após IDR. Teste manual adicional capturou uma janela própria,
convertendo/codificando na GPU, transmitindo via ICE/DTLS-SRTP e conferindo os
pixels recebidos, resize e recuperação via PLI. São peers no mesmo computador
com SDP/ICE trocados em memória; não se trata de teste de internet, sinalização
do servidor ou duas máquinas físicas. Cache NACK limitado está presente, mas
geração de pedidos NACK e aceitação de retransmissão/perda ainda não foram feitas.

Continuam pendentes coordenador de compartilhamento ligado à sala (separação
de eventos de voz/tela e gerações de sessão), controles da interface, renderização
recebida, teste com amigo pela internet, adaptação, múltiplos espectadores,
sincronização e áudio do sistema. Naquela etapa, o executável distribuído permanecia 0.5.0 com
prévia local; os testes e módulos novos não iniciam mídia extra no aplicativo.

## Estado atual: salas com voz e tela, Cloudflare local (0.6.0)

O compartilhamento agora está conectado à sala: captura explícita, H.264 por
hardware, conexões WebRTC separadas da voz, identificação de sessões, recepção
NV12 convertida para apresentação e entrega limitada à imagem mais recente.
Há seleção de transmissão, miniaturas, foco, tela cheia e zoom. O chat permite
reações; criar/sair de salas e controles do dono (trancar, limitar, expulsar e
silenciar) também estão disponíveis na interface. A apresentação
secundária é reduzida; rede e decodificação ainda recebem o fluxo completo.
O padrão atual é 720p30/2,5 Mbps e não inclui áudio do sistema.

O Worker privado implementa sinalização, presença, salas, texto, reações e
moderação em Durable Object SQLite. Convite obrigatório, limites de usuários,
pacotes/eventos e orçamento diário estão implementados. O cliente salva o convite
protegido pelo DPAPI. O Worker está publicado no plano Free; testes públicos de
convite, chat/reações e heartbeat passaram. Três clientes C++ usando esse Worker
trocaram voz/vídeo sintéticos, reconectaram e pararam um compartilhamento.
Esses processos rodaram no mesmo PC; aceitação com um amigo em outra rede segue
pendente. Veja `cloudflare/DEPLOYMENT.md` e `TESTAR_COM_AMIGO.md`.

Validação: sete suítes CTest; três clientes nativos com voz/vídeo sintéticos,
reentrada e parada de transmissão tanto no servidor Node real quanto no runtime
Cloudflare Miniflare; autorização, isolamento entre salas, texto, reações,
moderação e transferência de dono no Worker. As fixtures de hardware anteriores
validam WGC/GPU/H.264/transporte separadamente. Não houve ainda teste com dois
PCs em redes diferentes nem benchmark do cliente completo.
O pacote 0.6.0 compilou, iniciou e rejeitou todos os comandos de desenvolvimento;
contém somente um executável de cliente, bibliotecas de execução e licenças.

## Pendências para concluir a migração

### Pacote simplificado (0.6.1)

`desktop/out/Triscord.exe` contém o cliente e suas dependências; prepara uma
pasta de execução por hash no perfil do Windows e reutiliza essa pasta. Não
precisa de instalação manual, ZIP ou administrador. O lançador termina depois
de iniciar o cliente e não permanece monitorando recursos.

Servidor e convite são embutidos somente no build específico para o grupo;
os campos ficam ocultos e endereços antigos salvos são ignorados nesse modo.
O convite não vai para o Git, mas quem possui o binário pode extraí-lo e entrar
no grupo. Não prometemos segredo contra quem recebeu o executável.

Validação: cliente distribuído sem comandos de desenvolvimento, conexão/chat
com a Cloudflare usando configuração compilada e sem variáveis externas,
extração do arquivo único, igualdade dos arquivos preparados e abertura do
cliente real; segunda abertura reutilizou os arquivos sem regravá-los.
O roteiro atualizado está em `TESTAR_COM_AMIGO.md`.

### Funcionalidades e aceitação restantes

1. Microfone/alto-falantes e troca física de dispositivos, qualidade de fala e
   eco; voz/tela com um amigo, NAT e necessidade de TURN.
2. Áudio do sistema e sincronização, adaptação de banda e recebimento reduzido
   das telas secundárias; benchmark externo sob carga real.
3. Recursos mantidos em `FEATURE_SCOPE.md`: webcam/efeitos, soundboard, indicador
   de fala, teste de microfone, atalhos globais, volume/mute individuais,
   notificações, perfil e atualização automática.
4. Teste prolongado de limites/hibernação e aceitação externa do Worker Free publicado.
   O Worker não transporta voz/vídeo; STUN está configurado, TURN ainda não.
5. Instalador, migração de preferências e aceitação antes de substituir o estável.

A implementação ainda é uma prévia; não declaramos conectividade universal,
custo zero para relays nem melhora de consumo sem a validação correspondente.

## Interface reorganizada (0.6.2)

Salas na lateral esquerda, conversa e transmissão no centro, participantes
com avatar na direita e controles de chamada no rodapé. Áudio/dispositivos,
controle do dono e escolha de fonte usam janelas nativas sob demanda. Vídeo
parado não reserva painéis vazios; a transmissão recebida tem prioridade de
espaço e a prévia local fica menor. Texto de vazio e estado de conexão foram
ajustados, preservando entrada automática no pacote único para o grupo.

Salas/participantes reutilizam seus itens nas atualizações; avatares só são
preparados quando nome/cor mudam. Imagens de áreas ocultas ou da janela
minimizada não são redimensionadas para apresentação. A entrega mais recente,
miniaturas limitadas e threads de mídia permanecem. Não há animação decorativa,
WebView, monitoramento de recursos ou novos timers de interface.

O teste de interface usa um servidor WebSocket local e áudio injetado, sem
abrir microfone. Confirma atualização sem recriar itens, avatar, reação,
mostrar/ocultar transmissão e limpar a sala. Também cobre destruição de uma
janela conectada, corrigindo um acesso ao serviço de tela já destruído.
Oito suítes CTest passaram; integração Node com voz em 2/3/10 clientes, voz/tela
em três clientes, reconexão e política de recursos também passaram. A
configuração automática autenticou/trocou chat com o Worker publicado.

O pacote 0.6.2 continua em `desktop/out/Triscord.exe`. CPU/RAM/latência sob carga
real ainda precisam de comparação externa; não declaramos um ganho percentual
nem ausência de regressão de consumo com base apenas em testes funcionais.

## Etapa concluída: Markdown nativo do Discord no chat (0.9.20)

- Gramática recuperada dos módulos estáticos do Discord (478676, 999915, 694403, 223637, 683412, 704726, 873879, 652215).
- Motor C++ independente em `desktop/src/markdown_parser.h/.cpp` com árvore sintática (AST), sem navegador ou eval.
- Ordem de prioridade comprovada: regras ordenadas por `order`, desempate por presença de `quality` e qualidade numérica (`quality > bestQuality`), com interrupção monotônica por índice de primeiro caractere.
- Regras suportadas e verificadas:
  - Títulos `#`, `##`, `###` (1 a 3 níveis no início da linha; 4 níveis viram texto).
  - Subtexto `-# texto` sem aninhamento, com tipografia reduzida e muted.
  - Blocos de código ```` ```lang\ncode\n``` ```` e código inline `` `code` `` com fonte monospace e fundo AMOLED.
  - Citações em bloco simples `>` e multilinha `>>>`.
  - Negrito `**bold**`, itálico `*em*` e `_em_` (com lookbehind desativado conforme recuperado `H = false`), loose italics `*em *`, sublinhado `__u__` e tachado `~~s~~`.
  - Spoilers `||spoiler||`.
  - Links mascarados `[label](url)` com proteção anti-ReDoS, limite de aninhamento e validação de esquemas permitidos (`http:`, `https:`, `discord:`, `tel:`, `sms:`, `mailto:`).
  - Menções `<@id>`, `@everyone`, `@here`, `@silent` e emojis personalizados `<a?:name:id>`.
  - Tratamento gracioso de formatações não fechadas/incompletas sem loops infinitos ou quebras.
- Renderização nativa integrada ao delegado do chat (`desktop/src/chat_pane.cpp`) via `QTextLayout::setFormats`.
- Texto original preservado intacto em `Qt::UserRole`, exclusões e reações por ID inalteradas, texto acessível em `AccessibleTextRole` (a ocultação de spoilers foi corrigida em 0.9.21).
- Testes unitários dedicados em `desktop/tests/ui_tests.cpp`. Nove suítes aprovadas registradas em `desktop/out/chat-markdown-tests.log`.
- Captura de imagem real salva em `desktop/out/native-chat-markdown.png`.
- Executável portátil único 0.9.20 com SHA-256 `906f6de0a2f569f63f83af37a6a76cea6475c756f54d3cd85c4c3ef2c06ef5d8`.
- Cópia validada e atualizada na Área de Trabalho do usuário em `C:/Users/camargo/Desktop/triscord.exe`.


## Interface principal: interações do chat e revisão visual (0.9.21)

- Spoilers começam ilegíveis, inclusive em links/negrito internos e no texto acessível. Primeiro clique revela; segundo clique pode abrir o link. Estado fica na mensagem e desaparece ao sair da sala ou remover a linha.
- Links clicáveis usam QUrl em modo estrito, com esquemas recuperados permitidos. A abertura externa ocorre somente por clique; os testes interceptam o sinal sem abrir aplicativos.
- Datas `<t:...>` aceitam os nove formatos recuperados, padrão `f`, limite de 17 dígitos e validade de JavaScript Date. Formatação em português brasileiro e cores monocromáticas são adaptações nativas.
- Tempo relativo segue os limiares e arredondamento recuperados. Um temporizador por chat atende somente mensagens relativas visíveis; para ao ocultar o painel ou limpar a sala. Não coleta recursos.
- AST e formatos ficam em cache limitado pelas 200 linhas existentes; reações, seleção e repintura não analisam novamente o Markdown. Remoção/reset libera o cache.
- Correção da tipografia para fontes Qt definidas em pixels, usada no cliente.
- Revisão visual da chamada, duas transmissões, seletor por abas, configurações e janela estreita nas capturas reais dos testes. Controles continuam redimensionáveis e sem sobreposição.
- Não declara paridade integral com Discord: listas aninhadas e emojis remotos ainda têm limitações; efeitos de fundo, webcam física e teste com amigo pela internet permanecem pendentes.

Validação desta etapa: build, nove suítes e integração local com 2/3/10 participantes em `desktop/out/chat-interactions-build.log` e `chat-interactions-tests.log`. Reexecução final da UI em `chat-interactions-final-ui-tests.log`; inspeção de encerramento/áudio sob depurador em `chat-interactions-gdb-lifetimes.log` e `chat-interactions-gdb-lifetimes-ui.txt`.
Pacote de execução em `chat-interactions-package.log`; extração, abertura real e cache portátil em `chat-interactions-portable-tests.log`.
Executável 0.9.21: SHA-256 `519af158d1e789bc2374fe16ffef23e418bebf6ad6d2b9ed922c7222e4fdc013`. Destino: `C:/Users/camargo/Desktop/triscord.exe`.

A revisão detectou e corrigiu uso de membros já destruídos durante os sinais de reset do modelo Qt no encerramento do chat. O destrutor agora desliga as conexões antes de liberar o cache. O depurador também expôs um problema anterior de ordem de destruição no teste de decodificação de sons; o receptor de áudio agora é destruído enquanto o player de teste ainda existe. A correção desse teste não muda o cliente.
