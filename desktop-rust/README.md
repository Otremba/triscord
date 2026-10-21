# Triscord Rust Preview

Reescrita autorizada em 21/10/2026, com prioridade em estabilidade e desempenho no Windows. Tauri 2 e Rust substituem o host Qt/C++; Preact/TypeScript continua na interface. Os serviços de contas e controle permanecem nos Workers; o servidor de mídia permanece LiveKit na VPS.

Esta é uma **prévia de desenvolvimento incompleta**, não uma substituição da versão pública 0.9.45. Não há atualização automática para esta prévia. A janela, o identificador e o diretório de dados são próprios (`app.triscord.rust-preview`); nenhuma configuração ou sessão do aplicativo instalado é importada ou alterada. Recursos remotos são reais: criar/excluir servidores ou aceitar convites altera a conta no serviço existente.

## Implementado nesta etapa

- Host Tauri/WebView2 e núcleo Rust, sem Qt nem auxiliar Go no novo executável.
- Login pelo nome/senha e Google OAuth com PKCE, verificação do retorno local e definição inicial de apelido; restauração/revogação de sessão e definição de senha. A configuração Google fica em arquivo local ignorado e é incorporada somente ao núcleo compilado.
- Editor de perfil compartilhado com a interface existente, com campos de perfil e upload/remoção de avatar/faixa PNG, JPEG ou GIF. Uploads limitados, sequenciais, vinculados à conta e com expiração; os bytes dos GIFs são preservados. Recursos de imagem são carregados pelo núcleo a partir de hosts permitidos e enviados à interface como data URLs.
- Sessão em arquivo protegido por DPAPI do usuário Windows, com gravação atômica; tokens e senhas não fazem parte do estado enviado à página.
- Listagem, criação, seleção, exclusão e saída de servidores; criação e aceitação de convites.
- Controle WebSocket Engine.IO/Socket.IO compatível com o Worker: heartbeat, reconexão com espera progressiva, fila limitada, descarte de comandos antigos e geração de conexão.
- Diretório de salas, criação/entrada/saída para chat, histórico limitado a 200 mensagens, envio e exclusão das próprias mensagens. O rascunho é preservado até a confirmação por eco do servidor. Abrir o chat não ativa áudio; a entrada em voz é explícita.
- Voz com SDK oficial LiveKit Rust 0.9.6 e WASAPI: admissão pelo Worker, microfone inicialmente silenciado, recepção, mute/deafen, supressão WebRTC, ganho automático e seleção de dispositivos. Um controlador possui o ciclo dos dispositivos; admissões antigas não podem iniciar um microfone após saída/troca de sala. Recuperações transitórias usam o SDK; encerramento definitivo exige nova admissão pelo botão Reconectar voz. Sem validação em dispositivos reais.
- Preferências de supressão, ganho e dispositivos persistidas localmente por conta, com gravação atômica. Volumes individuais e intensidade numérica da supressão ainda pendentes.
- Interface explícita de prévia, reutilizando Preact, login e estilos da interface atual. O layout completo da aplicação estável permanece separado; fidelidade visual final ainda não foi portada para esta tela inicial.

## Ainda pendente

1. Recuperação de admissões após encerramento definitivo, diagnóstico de mídia e volumes individuais.
2. Intensidade de supressão, DSP avançado e retorno automático ao dispositivo padrão.
3. Captura de tela/janela, codificação por hardware, recepção e renderização acelerada, controle de qualidade e recuperação de vídeo.
4. Câmera, soundboard e sons da interface.
5. Perfis dos participantes/cache de avatares, configurações completas, moderação, notificações, tray e atualizador.
6. Paridade da interface existente e distribuição de prévias antes da substituição da versão estável.

Rust ajuda com memória/concorrência, mas não comprova estabilidade da rede, desempenho em jogos nem aceleração por hardware. Não há promessa de solução das quedas atuais por esta mudança.

## Compilar e verificar sem abrir o aplicativo

Instale as dependências já declaradas em `desktop/web/package-lock.json` (`npm ci` nessa pasta, se necessário). O script usa Rust com alvo MSVC e o compilador/Windows SDK em `.toolchain/msvc`, limita Cargo a dois trabalhos e executa as etapas sequencialmente. O SDK WebRTC fica em `desktop/out/webrtc-89d790b`, um caminho curto para evitar o limite de comprimento dos includes no MSVC. O artefato é fixado pela dependência do SDK; fontes/binários de terceiros ficam fora do Git.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop-rust/build.ps1
# Somente testes unitários, TypeScript e bundle, sem compilar o binário normal:
powershell -NoProfile -ExecutionPolicy Bypass -File desktop-rust/build.ps1 -CheckOnly
```

O bundle fica em `desktop/web/dist-rust` e o executável de desenvolvimento em `desktop/out/tauri-target/x86_64-pc-windows-msvc/debug/triscord-desktop.exe`, ambos ignorados pelo Git. `Cargo.lock` fixa a resolução das dependências. A compilação da interface Tauri não regenera ícones pelo código C++ nem inclui fontes proprietárias locais. A CSP permite somente recursos locais e o IPC; as requisições aos serviços são feitas pelo Rust, com timeout, respostas limitadas e redirecionamento desativado.

Os testes são unitários sem interface, com credenciais sintéticas e diretórios temporários. Não acessam contas/servidores de produção, configurações reais, câmera, captura de tela, microfone ou alto-falantes. Nenhum aplicativo/instalador é aberto pelo script. **`runtimeVerified=false`**; compilação e testes não equivalem à validação em execução ou de mídia real.

## Verificação desta etapa (21/10/2026)

Passaram 15 testes unitários Rust, os testes Node do contrato IPC, TypeScript e os bundles da interface. O executável Windows de desenvolvimento foi compilado com a toolchain GNU existente, sem ser aberto. A inspeção estática dos imports confirmou dependências do Windows e WebView2, sem Qt. O linker GNU emitiu avisos `corrupt .drectve` ao consumir bibliotecas de importação; a linkedição concluiu, mas esses avisos e a distribuição do loader WebView2 devem ser revisitados no empacotamento da prévia. O loader foi gerado ao lado do executável. Nenhum instalador, release, push ou deploy foi feito para a reescrita.

A etapa seguinte integra o SDK LiveKit e passa 19 testes sem interface, TypeScript e testes IPC, além da compilação completa MSVC. Os testes novos cobrem admissão antiga após saída/troca de sala, restrição do endpoint de mídia e preferências persistentes isoladas por conta. O cabeçalho do SDK cujo caminho tinha 261 caracteres impediu a compilação inicial; a pasta curta do SDK corrige a resolução dos includes sem modificar o conteúdo de terceiros. Avisos `corrupt .drectve` permanecem no build script do host GNU; o binário do aplicativo usa MSVC com CRT estático. Não houve execução do aplicativo nem de dispositivos: `runtimeVerified=false`.

Contas/perfis passam 25 testes sem interface e compilação MSVC. Novos casos incluem o vetor PKCE do RFC 7636, retorno com estado/host/parâmetros inválidos, cancelamento de login, limites/ordem/expiração de upload e preservação de bytes. Nenhum navegador foi aberto nem requisição a uma conta real foi feita pelos testes.

Captura/publicação: Windows Graphics Capture, conversão BGRA→NV12 e escala por D3D11, H.264 Media Foundation por hardware e envio direto de frames codificados ao SDK LiveKit. Filas limitadas, captura vinculada à fonte/processo e geração por tentativa de compartilhamento; limites de cadência cobertos por teste. Recepção, prévia, áudio de tela e fallback de captura ainda pendentes. Passaram 31 testes sem interface e compilação MSVC; nenhuma captura/codificação real foi executada: runtimeVerified=false.

Recepção de vídeo: conexão de tela permanece ativa ao parar a publicação; até oito tracks recebidas pelo SDK, fila de um quadro, superfícies filhas D3D11 e conversão NV12→BGRA por GPU. Não há JPEG/base64 de vídeo na interface. O decodificador utilizado é o do SDK; decodificação por hardware no Windows ainda não foi confirmada. Geometria limitada, suspensão por modais e máscaras para menus; falhas de apresentação produzem aviso. Novos testes cobrem planos com stride/padding, geometria inválida e geração de entrada na sala. Passaram 34 testes sem interface e compilação MSVC antes do último ajuste de encerramento, revalidado no build seguinte. Sem execução de GPU, captura, app ou E2E.

Estabilização e produção a custo zero: suporte a endpoints de mídia redundantes (`sslip.io`, `nip.io`, `duckdns`), sincronização de estados de usuários em chamada via LiveKit Data Channels (`RoomEvent::DataReceived`), módulo de áudio loopback por processo (`audio_loopback.rs`), catálogo de soundboard e tons nativos (`sound.rs`) e módulo de auto-atualização silenciosa com verificação SHA-256 e semver (`updater.rs`). Passaram 63 testes unitários sem interface, contrato IPC, TypeScript e compilação MSVC. Nenhum app/dispositivo foi aberto: `runtimeVerified=false`.

Paridade visual e acabamento estético com REA: tokens extraídos com evidências computadas do Discord (`tokens.generated.css`), animação do pill branco do guild rail com curvas bezier oficiais (hover 20px / ativo 40px), transição de squircle suave no hover de ícones de servidores (50% circular para 16px arredondado), anel de fala verde pulsante (`#23a55a`) no avatar ativado pelo LiveKit, badge vermelho "AO VIVO", agrupamento temporal de mensagens em janelas de 5 minutos, parser client-side de Markdown com blocos de código com destaque de sintaxe, botão de cópia de código e revelação de spoilers (`||texto||`), e barra de controles flutuantes translúcida com `backdrop-filter: blur(12px)`.


