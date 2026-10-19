# Cantos da janela — Discord × Triscord — 18/10/2026

## Evidência e limites

- REA pela CLI 6.5.0, sem alterar configuração MCP: `out/rea-window-corners-20261018.json`, `ev_168f03635b2c8864e3810da7793afa74eeb49b56128daec8f1e14a70617d9a6f`, para o `resources/app.asar` instalado (wrapper, 221 bytes). Esse wrapper não contém a implementação da janela principal.
- Bootstrap real `resources/_app.asar`: SHA-256 `cbd26748b01c1b4847dc5471c4d2e1e46d69b0eb6f6c3347aa66ca992267e9b8`, evidência REA `ev_e60178ee28183b45c132252b1e5e10ef3f7c288691178cb8f51b8b97720320d3`, em `out/rea-window-host-20261018.json`. Análise estática, sem execução dos bundles. A configuração recuperada da splash é `frame:false`, `transparent:false`; ela não prova a política nativa da janela principal.
- Inspeção nativa **separada do REA**, por consulta somente de leitura ao HWND do Discord instalado `app-1.0.9262/Discord.exe`: `DWMWA_WINDOW_CORNER_PREFERENCE` (33) retorna **2 / DWMWCP_ROUND**. O Triscord anterior retorna **0 / DEFAULT**. Registro em `out/window-corners-evidence/native-before.json`.
- Inspeção visual pela skill Computer Use confirmou os cantos arredondados do Discord restaurado e do cliente de teste corrigido. As janelas do usuário não foram encerradas nem sua chamada alterada. Nenhuma decompilação nativa foi feita; a conclusão da política de cantos vem da leitura do HWND real, não do analisador JavaScript.

## Correção

O Triscord usa `Qt::FramelessWindowHint`, sem moldura de sistema. O host agora pede a mesma política DWM do Discord e estende uma borda nativa de 1 pixel para permitir o recorte e a composição. A página e os vídeos continuam sendo recortados pelo compositor nativo, sem uma máscara fixa que possa atrapalhar sombras ou redimensionamento.

A janela principal implementa maximizar por geometria, devido ao fluxo existente de restaurar após tela cheia. Por isso a política também recebe `mainMaximized`: **1 / DONOTROUND** ao maximizar ou entrar em tela cheia; **2 / ROUND** ao restaurar. Arrastar ou redimensionar a janela maximizada limpa esse estado. O popout usa os estados nativos Qt, monitorados pelo host.

Fontes oficiais da API: [política de cantos](https://learn.microsoft.com/windows/win32/api/dwmapi/ne-dwmapi-dwm_window_corner_preference), [arredondamento de janelas](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/ui/apply-rounded-corners), [moldura DWM](https://learn.microsoft.com/en-us/windows/win32/dwm/customframe). A API de preferência de cantos depende do Windows 11; não foi validada equivalência visual em Windows 10, RDP ou máquinas virtuais.

## Validação

`tests/e2e/run_web_window_frame_e2e.py` executa o cliente Qt/WebView2 real com perfil isolado e comandos pela ponte do próprio app. Consulta o HWND e verifica duas sequências completas: **ROUND → DONOTROUND → ROUND → DONOTROUND → ROUND**, com tamanho restaurado de 1264×892 preservado. Resultado aprovado em `out/web-window-frame-e2e/result.json`.

Escopo desta correção: a moldura/cantos da janela principal e do popout. Não representa uma nova auditoria completa de toda a interface do Discord.

Também aprovados nesta rodada: 29 verificações da chamada real com dois clientes/mídia sintética/backend local; 17 da janela destacada (inclusive tela cheia, retorno e vídeo nativo); typecheck/build e 44 verificações do pacote/portátil.

Entrega: **0.9.24**, `C:/Users/camargo/Desktop/Triscord.exe`, SHA-256 `BA3D0F0B3BE378D87101AD5DE9BC024C9D695E0B9AAF02E2A93D6DE510824273`. Backup anterior em `out/previous-desktop-0.9.23.exe`. O processo antigo do usuário continua intacto; é preciso reabrir o aplicativo para carregar esta versão. Sem commit, push, deploy ou alterações na instalação do Discord.
