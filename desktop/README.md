# Cliente Triscord

O cliente distribuído é `triscord-web.exe`: núcleo C++20/Qt e interface Preact/TypeScript hospedada em WebView2. A versão atual é definida em `CMakeLists.txt`.

## Dependências

- Windows x64, Qt 6.8.3 com WebSockets e Multimedia, MinGW 13.1, CMake e Ninja.
- Node 22 ou superior para preparar a interface; Python para ferramentas e validação.
- SDK WebView2 em `.toolchain/webview2/build/native/`, com `include/WebView2.h` e `x64/WebView2Loader.dll`.
- Runtime WebView2 instalado na máquina que executa o aplicativo.

`npm run setup:desktop`, a partir da raiz, instala Qt, MinGW, ferramentas de compilação e o SDK WebView2 dentro de `.toolchain/`. As bibliotecas nativas e suas revisões ficam em `cmake/NativeMedia.cmake`.

## Compilar e abrir

Na raiz do repositório, após preparar as dependências:

```powershell
npm ci
npm --prefix desktop/web ci
npm run build:desktop
npm start
```

O build de desenvolvimento inclui ferramentas de diagnóstico. `npm start` abre `desktop/out/build/triscord-web.exe` com os assets de `desktop/web/dist/`. O build distribuído desabilita os comandos de automação e depuração.

Para disponibilizar DeepFilterNet no modo de alta qualidade, execute `desktop/scripts/build-deepfilter.ps1` antes de recompilar. Sem ele, o áudio usa RNNoise. O controle de intensidade é salvo nas configurações locais.

## Código e documentação

- `src/`: serviços nativos, mídia, transporte e ponte com a interface.
- `web/`: interface atual e suas dependências próprias.
- `assets/`: recursos e avisos de licença dos recursos.
- `scripts/` e `packaging/`: preparação e distribuição.
- `tests/` e `tools/`: testes e ferramentas de diagnóstico.
- [Empacotamento](packaging/README.md) e [notas de arquitetura](ARQUITETURA_WEBVIEW2.md).

Os componentes Qt Widgets e alguns alvos de diagnóstico continuam usados pelas ferramentas e testes; não são o cliente principal. Relatórios de versões anteriores estão em [`docs/history/desktop/`](../docs/history/desktop) e descrevem o estado da época.

## Validação

`npm run typecheck` verifica a interface; `npm run lint` e `npm test` verificam o código e testes unitários do servidor de compatibilidade. A suíte completa desse servidor tem comando separado: `npm run test:server`. Testes C++ usam QtTest/CTest. Harnesses em `tests/e2e/` exigem execução explícita e podem abrir clientes e servidores locais; não fazem parte da validação automática padrão.

Builds, caches, credenciais e evidências locais ficam em `out/` ou `.toolchain/`, ignorados pelo Git. [Licenças](THIRD_PARTY_NOTICES.md) devem acompanhar a distribuição.
