# Prévia local da câmera — 18/10/2026

## Implementação

- Menu da câmera: **Prévia da câmera** abre uma prévia local. Configurações → Voz e vídeo → Câmera: **Testar vídeo / Parar teste**.
- Não entra numa sala nem publica câmera. Fora de uma transmissão, usa um `CameraService` separado, sem conexão com sinalização/WebRTC. Se a câmera já estiver transmitindo, reaproveita os quadros locais do publicador, sem abrir o dispositivo novamente; fechar a prévia preserva a transmissão.
- Quadros de prévia são miniaturas efêmeras: até 640×360, 5 fps, JPEG limitado a 128 KiB antes de base64; não entram no snapshot da sessão, histórico, arquivos ou mensagens para outros clientes. Cada consumidor usa um identificador próprio; uma parada atrasada de uma janela antiga não cancela a prévia nova.
- A interface renova uma licença de captura a cada 2 segundos. Sem renovação, o núcleo encerra em 6,5 segundos. Fechar o componente, sair da conta, fechar a janela, reiniciar o renderer, ativar a transmissão ou trocar o dispositivo encerra a captura correspondente. Erros de captura são exibidos na prévia.
- Corrigido também o acesso às configurações dentro da janela destacada: o evento já existia, mas essa janela não renderizava `Settings`.

## Evidência REA e fidelidade

Análise estática real pela CLI REA 6.5.0: `out/rea-camera-preview-20261018.json`, evidência `ev_04a03d6de51a97b2f4ebf293de7ecb997d0f05801df0eab62fa6146774617e5e`. Entrada: uma cópia do chunk público preservado `30bab6af3517c471.js`, SHA-256 `643c57c2ebe42a2e27eca9be86fa9ae34cc6b8c8ebe311cf2865e78e86439e30`.

No byte/caractere ASCII 171020 começa o trecho `CAMERA_VIDEO_PREVIEW`: o componente de câmera recebe `deviceId`, `width:387`, `height:218`, `disabled:!previewEnabled`. O painel fica desativado por padrão e o botão habilita a prévia. Esses dados orientaram o viewport de 387×218 e o início explícito pelo usuário. O REA não executou o bundle nem resolveu todas as dependências externas desse chunk.

O item “Prévia da câmera” do menu é uma observação anterior da auditoria visual de 18/10. O modal novo usa o componente de diálogo já reconstruído do projeto; a existência de um modal idêntico no Discord **não foi observada**. A localização do recurso e a operação são implementadas, mas não se afirma fidelidade visual completa desse estado.

## Verificação

`tests/e2e/run_web_camera_preview_e2e.py`: dois executáveis Qt/WebView2 reais, Workers/D1 locais e fonte de imagem sintética. Verifica imagem animada, dimensões, funcionamento fora da chamada, abertura por menu/configurações, parada por Escape/botão, câmera existente preservada, expiração sem interface, IDs antigos ignorados e saída da conta. O segundo cliente verifica que não recebeu câmera nem stream durante a prévia. Inclui ainda erro/repetição com um identificador de dispositivo inexistente no serviço real, sem abrir webcam física.

Limites: ainda faltam webcam física, permissões reais do Windows e teste entre duas redes. O caminho de erro de dispositivo inexistente não comprova imagem de uma webcam conectada.

Resultados: **23/23** verificações da prévia e **8/8** regressões de configurações aprovadas. A captura sintética `out/camera-preview-visual/preview.png` foi inspecionada visualmente; depois foi acrescentado um espaço de 16 px entre o seletor e a imagem. Typecheck/build e verificação do pacote/portátil também passaram; o manifesto da entrega final fica em `out/portable-web-package.json`.

Entrega: **0.9.25**, `C:/Users/camargo/Desktop/Triscord.exe`, SHA-256 `A931DBD446A6E07CE1F7D436458104D31225049319C88589EEE80962279E3D17`; 44 verificações do pacote/portátil aprovadas. Backup anterior em `out/previous-desktop-0.9.24.exe`. Sem commit, push ou publicação; os processos do usuário não foram encerrados.
