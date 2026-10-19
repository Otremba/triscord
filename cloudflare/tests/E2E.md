# Testes integrados da branch C++/Qt

Executar a partir de `cloudflare/`, com dependências instaladas por `npm ci` em `cloudflare/` e `cloudflare-auth/`. Node >=22, conforme o Wrangler instalado. Nenhum comando abaixo publica Workers ou acessa o D1 de produção.

```powershell
npm test
npm --prefix ../cloudflare-auth test
npm run test:e2e
npm run test:e2e:native
```

O último comando exige `desktop/out/build/native-hub-api-tests.exe` atualizado. Build local: `desktop/scripts/build.ps1 -DevTools`, executado da raiz, sem outro build/teste Qt concorrente. Alternativamente definir `TRISCORD_NATIVE_API_TEST` com o caminho do executável de teste. O CI nativo executa os Workers no Linux e o fluxo Qt integrado no Windows, incluindo alterações em `cloudflare-auth/` no filtro de caminhos. O workflow foi editado localmente; sua execução remota depende de envio ao GitHub.

## O que o novo E2E executa

`e2e.test.mjs` inicia dois bundles reais dos Workers no Miniflare/workerd com um D1 compartilhado descartável. Um ingress local encaminha HTTP e WebSocket sem substituir a lógica dos serviços. O Google é uma fixture local com chave RSA temporária e JWKS: a verificação criptográfica e a emissão de sessão são reais, mas não há login na conta Google do usuário. Credenciais de produção e QSettings não são lidos.

- Login, edição do perfil e exclusão de email/notas do perfil público.
- Upload/download com comparação dos bytes, isolamento entre contas e consistência D1 após PUT/DELETE simultâneos.
- Criação de servidor, membro obrigatório, convites exclusivos do dono e disputa pelo último uso. Verifica número de membros e contador de usos no banco.
- Quatro disputas de apelido sem diferenciar maiúsculas/minúsculas: uma resposta 200, outra 409/nick_taken; apenas um registro correspondente no D1.
- Oito primeiros logins simultâneos para a mesma conta: sessões válidas e apenas uma conta criada.
- Sessão expirada ou revogada rejeitada por auth, hub e novo handshake WebSocket; cabeçalho de identidade forjado não autentica o chamador.

Com `--native`, inicia o executável Qt sem UI: QNetworkAccessManager faz login/perfil e as classes reais HubApi, ProfileMediaClient, RemoteImageCache e Signaling completam upload/leitura, criação/entrada/listagem de servidor e chat entre dois participantes. O chat deve usar a identidade da sessão, mesmo com identidade falsa no payload. Tentativa de moderação por outro participante não pode silenciar o dono. Exclusão de mídia e logout fecham o fluxo. O teste nativo tem prazo de 60 s; relatório em `desktop/out/backend-e2e/native.txt`. Fora do harness, esse caso é explicitamente ignorado pelo CTest, sem chamar produção.

## Resultado local em 16/10/2026

O teste de concorrência encontrou uma resposta **500** ao disputar o mesmo apelido: ambas as requisições passavam pela consulta de disponibilidade antes do UPDATE. A correção em `cloudflare-auth/src/worker.js` transforma exclusivamente o conflito UNIQUE de `accounts.nick_lower` em **409/nick_taken**, mantendo outros erros visíveis. O teste integrado passou após a correção; os testes existentes de auth, mídia, migrações e hub também passaram.

Validação final: `npm test` em ambos os projetos passou; `npm run test:e2e:native` passou, incluindo as quatro disputas de apelido e o caso Qt (903 ms nessa execução). O CTest direcionado `native-hub-api` passou em 2,88 s: 12 casos passaram e 1 foi ignorado por exigir o harness; esse mesmo caso passou na execução E2E separada. Não foi necessário repetir as suítes gráficas, pois nenhum código de UI do produto mudou.

Durante a construção do harness, usar `scriptPath` fora da raiz do pacote causou erro interno de inicialização do Miniflare; carregar os bundles como texto resolveu. O ingress local também apresentou ECONNRESET com conexões HTTP reutilizadas pelo fetch do Node 26: o driver JavaScript usa Connection: close. O cliente Qt mantém seu transporte normal. Isso limita a cobertura de pooling HTTP pelo driver JavaScript; não foi tratado como bug de produção. Uma primeira asserção de moderação esperava request-error, mas o contrato existente ignora o comando: o teste final verifica ausência do efeito após uma mensagem de confirmação processada na mesma conexão.

## Limites

Atualização posterior: a camada de falhas/recuperação e revogação de sockets agora está em `RECOVERY.md`, executável por `npm run test:recovery`. Ela supera as lacunas de sockets/reinício mencionadas abaixo dentro dos limites documentados.

Não é automação da interface gráfica completa nem teste do OAuth real. Não prova comportamento do D1/Workers hospedados, TURN relay, WAN ou câmera física. Logout é verificado em novas requisições/handshakes; revogação de sockets já abertos não está coberta. Reinício/hibernação, falhas injetadas, fuzzing e carga prolongada continuam como próximas camadas. A correção do apelido ainda precisa de publicação para mudar produção; não foi feito deploy nesta rodada.
