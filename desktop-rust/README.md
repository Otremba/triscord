# Triscord Rust Preview

Reescrita autorizada em 21/10/2026, com prioridade em estabilidade e desempenho no Windows. Tauri 2 e Rust substituem o host Qt/C++; Preact/TypeScript continua na interface. Os serviços de contas e controle permanecem nos Workers; o servidor de mídia permanece LiveKit na VPS.

Esta é uma **prévia de desenvolvimento incompleta**, não uma substituição da versão pública 0.9.45. Não há atualização automática para esta prévia. A janela, o identificador e o diretório de dados são próprios (`app.triscord.rust-preview`); nenhuma configuração ou sessão do aplicativo instalado é importada ou alterada. Recursos remotos são reais: criar/excluir servidores ou aceitar convites altera a conta no serviço existente.

## Implementado nesta etapa

- Host Tauri/WebView2 e núcleo Rust, sem Qt nem auxiliar Go no novo executável.
- Login pelo nome/senha com os Workers existentes, restauração/revogação de sessão e definição de senha.
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
5. Google OAuth, perfis/avatares, configurações, moderação, notificações, tray e atualizador.
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
