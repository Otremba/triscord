# Documentação

Comece pelo [guia do cliente atual](../desktop/README.md).

- [Empacotamento](../desktop/packaging/README.md): portable, instalador e arquivos locais necessários.
- [Arquitetura e evidências da interface](../desktop/ARQUITETURA_WEBVIEW2.md).
- [Backend de salas](../cloudflare/README.md) e [implantação](../cloudflare/DEPLOYMENT.md).
- [Backend de autenticação](../cloudflare-auth/RELEASE_READINESS.md).
- [Histórico de engenharia](history/README.md): relatórios antigos, sem força de instrução atual.

A `main` contém o cliente C++/Qt com Preact/WebView2. O Electron não é mais compilado nem publicado a partir da árvore atual. As tags anteriores preservam seu código para consulta e para preparar uma futura migração.

CI automática verifica unidades do servidor de compatibilidade, os componentes dos Workers e a interface sem abrir aplicativos. A compilação Windows é um workflow manual. Nenhum desses workflows executa E2E automaticamente; harnesses existentes exigem decisão explícita.
