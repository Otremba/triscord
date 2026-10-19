# Distribuição do Triscord

O pacote atual usa `triscord-web.exe` (C++/Qt + WebView2). O código Electron e o empacotador antigo Qt Widgets não fazem parte da distribuição atual.

## Preparação

Prepare as dependências do [guia do cliente](../README.md), o NSIS 3.11 em `.toolchain/nsis-3.11/` e o filtro de alta qualidade com `desktop/scripts/build-deepfilter.ps1`.

O NSIS pode ser obtido no [pacote oficial](https://sourceforge.net/projects/nsis/files/NSIS%203/3.11/nsis-3.11.zip/download); SHA-256: `c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1`.

Builds distribuídos usam arquivos locais ignorados pelo Git:

- `desktop/out/google-client-secret.txt`: configuração do cliente OAuth desktop.
- `desktop/out/cloudflare-group-invite.txt`: convite padrão do grupo, quando aplicável.

Não coloque esses valores no código ou em logs. Um convite incluído no binário pode ser extraído por quem o recebe; não é uma credencial confidencial.

## Gerar os arquivos

Na raiz do repositório:

```powershell
npm run package:desktop
```

O script compila a interface e o núcleo, monta staging próprio e produz:

- `desktop/out/triscord-web.exe`: lançador portátil.
- `desktop/out/Triscord-Setup-<versão>.exe` e `.sha256`: instalador e checksum.
- `desktop/out/portable-web-package.json`: versão, staging, hashes e estado da validação.

O padrão inclui verificações de execução do pacote. Quando a execução de aplicativos estiver proibida, use explicitamente `./desktop/scripts/portable-web.ps1 -SkipRuntimeVerification`; ainda são conferidos arquivos obrigatórios e o hash do modelo, e o manifesto informa `runtimeVerified=false`. Não trate isso como validação ponta a ponta.

O cliente distribuído não aceita os comandos de depuração/automação habilitados em desenvolvimento. Inclua todas as [licenças](../THIRD_PARTY_NOTICES.md). O aplicativo requer o Runtime WebView2 no Windows.

## Publicação

Publique o instalador e seu `.sha256` em uma release pública `desktop-v<versão>`. O atualizador nativo consulta esse canal ao iniciar e verifica o instalador. A publicação deve corresponder ao commit usado para compilar; não substitua arquivos de uma release já publicada.

`node site/stage.mjs` prepara o site a partir do manifesto local. Instaladores acima de 25 MiB são servidos pela release no GitHub, por redirecionamento; arquivos menores podem ser copiados para o site. A implantação no Cloudflare Pages é uma etapa separada.

O instalador usa `%LOCALAPPDATA%/Triscord/app` e mantém os dados fora da pasta do programa. O portable extrai um runtime identificado pelo conteúdo e pode redirecionar para a instalação após uma atualização.

Os scripts não publicam automaticamente nem encerram instalações em uso durante a preparação do pacote. O [histórico do empacotamento anterior](../../docs/history/desktop/PACKAGING_QT_WIDGETS.md) foi preservado apenas para consulta.
