# Entrega da interface web — retomada de 17/10/2026

Concluído o último pedido da conversa Claude: janela principal sem moldura nativa, com barra própria, mover/redimensionar e retorno correto após maximização/tela cheia. A implementação visual foi feita pelo Claude; nesta retomada, as capturas e os registros finais foram conferidos e a entrega foi corrigida.

## Problema encontrado e correção

O pacote anterior da Área de Trabalho era Qt Widgets: `portable.ps1` copia e executa `triscord-native.exe`, mesmo quando os E2E são feitos contra `triscord-web.exe`. Logo, copiar o arquivo produzido por esse script não entregava a interface web que estava sendo testada.

Agora `portable-web.ps1` compila o cliente web em release, sem ferramentas de desenvolvimento, inclui interface/fontes/loader/bibliotecas/licenças e produz `out/triscord-web.exe`. O NSIS recebe entry point explícito; o manifesto identifica `interface: webview2`. O empacotador Qt anterior foi preservado e agora identifica claramente `qt-widgets`.

## Entrega conferida

- Atualizado: `C:/Users/camargo/Desktop/triscord.exe`.
- SHA-256 do portátil e da cópia da Área de Trabalho: `B0D942A1D314F142EA4A1FBD2F512F7484AC05697019A8447AD68681E5AF2505`.
- Package ID: `a07cd6f9ee73d1ea48ef`.
- Entry point real do pacote: `triscord-web.exe`.
- Backup do executável Qt anterior: `out/desktop-backups/triscord-qt-C858C157.exe`, SHA-256 `C858C157D6B26175D8347BE82CE86393DC90B6764195D03AD577F866A2A2737C`.
- Metadados locais: `out/portable-web-package.json` e `out/web-desktop-delivery.json`.

O arquivo final não precisa do checkout, Node, Python ou toolchain para abrir. Precisa do WebView2 Runtime instalado no Windows; o motor não é baixado nem instalado pelo pacote. O runtime foi confirmado nesta máquina. A cópia foi feita após os testes e com guarda do hash anterior, sem fechar instâncias pessoais do usuário. Testes usaram configurações isoladas e backend/mídia locais; nenhuma publicação de Worker foi feita.

## Validação desta retomada

- Typecheck/build da interface e builds C++ de desenvolvimento/release passaram.
- Verificador de release: **21/21**. Identidade C++/WebView2, 14 opções de teste ausentes/rejeitadas, payload com um único app, assets/loader/licenças, renderer real iniciado, janela sem moldura e captura do login. Não há Qt6Widgets.dll no payload.
- Verificador do portátil: **23/23**, incluindo abertura pelo NSIS e comparação SHA-256 de todos os arquivos extraídos com o staging. Repetido após corrigir a descoberta do processo sob virtualização MSIX/LocalCache do Codex. A primeira tentativa incompleta foi um problema desse verificador, não uma aprovação de entrega.
- E2E da visão da chamada: **29/29**, com tela cheia, geometria normal/maximizada restaurada, chat preservado, ocultar/mostrar vídeo e troca de sala.
- E2E da janela destacada: **17/17**. A contagem de 18 no relato antigo do Claude estava incorreta.
- CTest: **12/12** suítes.

O teste físico de arrastar/redimensionar/duplo clique (cinco verificações) já passou no último registro do Claude, às 01:59:27 UTC de 18/10. Foi conferido e citado com essa proveniência; não foi repetido com o cursor nesta retomada. `out/claude-verify-frame.log` contém uma execução anterior que falhou e não deve ser tratado como resultado final.

Capturas revisadas: `out/web-focus-e2e-report/focused-view.png` (principal sem a moldura duplicada) e `out/web-portable-verification/release-login.png` (login com botões próprios). Os dados de testes em `out/` são locais/ignorados pelo Git. Sem commit nesta rodada.

## Reproduzir

```powershell
./desktop/scripts/portable-web.ps1
```

Veja também `packaging/README.md` e a Fase 13d de `ARQUITETURA_WEBVIEW2.md`. O script produz/verifica o pacote, mas não altera a Área de Trabalho automaticamente.

Ainda requerem validação: DPI 125/150%, múltiplos monitores/Snap e chamadas reais com hardware/duas redes. Esta entrega não declara paridade visual integral nem uma nova medição de desempenho em produção.
