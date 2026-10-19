# Escolha do cliente distribuído

Para distribuir a **interface nova C++/WebView2**, execute a partir da raiz:

```powershell
./desktop/scripts/portable-web.ps1
```

Saída: `desktop/out/triscord-web.exe` (lançador portátil); manifesto em `desktop/out/portable-web-package.json`. O pacote abre `triscord-web.exe`, inclui assets web, fontes, WebView2Loader e bibliotecas/licenças. Exige o WebView2 Runtime instalado no Windows; o motor do navegador não é incluído nem instalado automaticamente. O usuário final não precisa de Python, Node, da toolchain nem do checkout.

A versão distribuída não aceita `--devtools`, scripts, sondas, captura, troca de assets ou encerramento programado. A compilação de desenvolvimento (`TRISCORD_BUILD_DEV_TOOLS=ON`) mantém esses recursos para os E2E. `TRISCORD_BUILD_WEB_CLIENT=ON` permite compilar o cliente web sem as ferramentas de desenvolvimento. O empacotador verifica o runtime de staging e também o lançador/executável extraído, em perfis descartáveis, antes de publicar o manifesto de sucesso.

Cada staging usa uma pasta nova sob `desktop/out/web-package-stage/`. O NSIS recebe `APP_EXE=triscord-web.exe`, e o hash do pacote considera essa escolha junto com todos os arquivos. O script não substitui automaticamente o arquivo da Área de Trabalho. O runtime usa extração versionada e mutex, como descrito abaixo. A configuração do grupo continua vindo de `desktop/out/cloudflare-group-invite.txt`; seu conteúdo não é impresso.

`portable.ps1` continua sendo o empacotador **anterior, Qt Widgets** e produz `desktop/out/triscord.exe`. Não confundir esse arquivo com o novo pacote web. O NSIS mantém `triscord-native.exe` como padrão para não alterar esse fluxo.

---

# Executável único para o grupo

`desktop/scripts/portable.ps1` produz `desktop/out/triscord.exe`: basta enviar
esse arquivo aos amigos. Ele prepara as bibliotecas automaticamente em
`%LOCALAPPDATA%/TriscordNative/runtime/<hash>` na primeira execução e abre o
cliente. Execuções seguintes reutilizam essa pasta. O lançador termina depois
de iniciar o cliente: não há serviço, processo de monitoramento, prompt de
instalação, requisito de administrador ou download de dependências em execução.

O hash do pacote evita sobrescrever uma versão em uso. Um mutex serializa a
extração e o marcador só é escrito quando ela termina. Falhas/interrupções
sem marcador são corrigidas na próxima tentativa. As DLLs Qt permanecem
substituíveis no diretório de execução e as licenças são distribuídas com elas.

## Compilar

Instale localmente o ZIP oficial
[NSIS 3.11](https://sourceforge.net/projects/nsis/files/NSIS%203/3.11/nsis-3.11.zip/download)
em `.toolchain/nsis-3.11`. SHA-256 do ZIP:
`c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1`.
Não é necessário instalar NSIS no Windows nem alterar o PATH.

```powershell
./desktop/scripts/portable.ps1
```

O convite padrão vem do arquivo ignorado `desktop/out/cloudflare-group-invite.txt`;
outro arquivo pode ser informado com `-GroupInviteFile`. CMake gera um cabeçalho
somente no diretório de build ignorado. O convite nunca vai para os fontes ou
logs do build. O pacote específico do grupo usa o servidor publicado e o convite
automaticamente, ignorando configurações antigas de servidor. Só solicita o nome.

**Quem possui esse executável pode entrar no grupo.** O convite pode ser extraído
do binário; não constitui proteção contra quem recebeu o pacote. Mantenha a
distribuição entre os amigos. Para revogar acesso, altere o segredo na Cloudflare
e gere outro pacote. A versão genérica (`build.ps1` sem `-GroupInviteFile`) mantém
servidor/convite configuráveis e não inclui credenciais do grupo.

O cliente continua C++/Qt. O arquivo distribuído é único, mas as bibliotecas são
preparadas em disco para execução. Assinatura digital e atualização automática
continuam pendentes; diagnóstico e ferramentas de desenvolvimento não são incluídos.
