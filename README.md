# Triscord

Aplicativo para Windows com voz, câmera, compartilhamento de tela, chat e soundboard. O núcleo é **C++20/Qt** e a interface usa **Preact em WebView2**.

**[Baixar para Windows](https://triscord.pages.dev/download)** · [Releases nativas](https://github.com/Otremba/triscord/releases)

Uma [reescrita em Tauri 2/Rust](desktop-rust/README.md) está em desenvolvimento, com dados locais separados e recursos ainda incompletos. A versão pública acima continua sendo o cliente C++/Qt.

## Organização

| Pasta | Conteúdo |
| --- | --- |
| `desktop/src/` | Núcleo C++, áudio, vídeo, autenticação e integração com WebView2 |
| `desktop-rust/` | Prévia da reescrita Tauri/Rust, sem substituir a versão pública |
| `desktop/web/` | Interface Preact/TypeScript e estilos |
| `desktop/scripts/` e `desktop/packaging/` | Compilação e instaladores |
| `desktop/tests/` | Testes nativos e ferramentas de validação |
| `cloudflare/` | Salas, servidores e sinalização |
| `cloudflare-auth/` | Contas, perfis e mídia |
| `shared/` | Catálogo compartilhado do soundboard |
| `server/` | Servidor Node de compatibilidade e suporte aos testes locais |
| `site/` | Site e preparação dos downloads |
| `desktop/tools/` | Ferramentas auxiliares de mídia e investigação |
| `docs/` | Guia de manutenção e histórico de engenharia |

## Desenvolvimento

Consulte o [guia do cliente](desktop/README.md) para dependências e compilação. Node é usado nas ferramentas de desenvolvimento; o aplicativo distribuído não inclui Electron nem depende de Node.

```powershell
npm ci
npm --prefix desktop/web ci
npm run build:web
npm run typecheck
npm run build:desktop
npm start
```

`build:desktop` requer Qt, MinGW e o SDK WebView2 preparados conforme o guia. `npm start` abre o executável nativo de desenvolvimento já compilado.

## Manutenção

- [Empacotamento e publicação](desktop/packaging/README.md)
- [Arquitetura e investigação da interface](desktop/ARQUITETURA_WEBVIEW2.md)
- [Autenticação](cloudflare-auth/RELEASE_READINESS.md) e [servidor de salas](cloudflare/DEPLOYMENT.md)
- [Notas históricas](docs/history/README.md)

Os clientes nativos usam releases `desktop-v*`. Usuários do Electron antigo podem instalar a versão atual pelo site; a migração automática entre os dois canais ainda não foi implementada. O código legado está preservado no histórico Git, inclusive na tag `v1.1.9`.

SDKs, credenciais, builds e resultados locais não são versionados. A suíte ponta a ponta permanece disponível, mas não é executada automaticamente.
