# Prontidão para publicação — 16/10/2026

## Publicação concluída

O usuário autorizou explicitamente migrar e publicar nesta conversa. As **18 alterações aditivas foram aplicadas**, e a verificação posterior de `npm run db:plan` retornou `pending: 0`.

- `triscord-auth`: versão `6ccfd460-afcb-4c50-9c67-36bdab0bbe95` publicada.
- `triscord-control`: versão `ef937575-9eb6-40da-a84f-da9f3f4b0236` publicada.
- `npm run test:remote`: passou. Health 200 em ambos; `/me`, mídia de perfil, `/servers` e `/ice` rejeitam chamadas sem sessão com 401. As rotas do hub deixaram de retornar 404.
- Não houve leitura de dados pessoais, criação de usuários de teste, obtenção de TURN autenticado ou escrita autenticada nos testes de produção.
- Não foi contratado novo produto ou alterado o plano da conta.

## Estado anterior à publicação

Depois de autorização OAuth do usuário, as consultas D1 de metadados funcionaram. Nenhum conteúdo de conta ou sessão foi consultado.
Permissões solicitadas: `account:read`, `user:read`, `workers_scripts:write`, `d1:write` e renovação offline; credenciais continuam no cofre do Windows.

- Banco `triscord-accounts`: existem `accounts` (sete colunas originais), `sessions` e índice `sessions_account`; faltam perfil, mídia e servidores.
- Auth `/health`: 200, `/me` sem sessão: 401.
- Hub `/health`: 200, `/servers` e `/ice`: 404; versão publicada ainda não contém essas rotas.
- Os segredos `INVITE_CODE` e `TURN_API_TOKEN` existem no hub. Somente os nomes foram consultados.
- `npm run db:plan` gerou **18 alterações aditivas**: quatro tabelas, dois índices e doze colunas. Nenhum DROP, DELETE ou UPDATE de dados.
- Plano completo gerado no worktree do Codex: `cloudflare-auth/out/migration-plan-20261016.json` (ignorado pelo Git, somente metadados).

## Procedimento preparado

No diretório `cloudflare-auth`:

```powershell
npm run db:plan
# Somente após aprovação de publicação:
npm run db:migrate
npm run deploy
```

Depois, no diretório `cloudflare`:

```powershell
npm run deploy
```

O migrador inspeciona o esquema atual, aplica somente objetos/colunas ausentes e verifica que não restou pendência.
Reexecutar depois de uma interrupção recalcula o plano. Não usa `--file` para reaplicar cegamente todos os ALTER TABLE.
Não existe rollback destrutivo automático: as alterações de esquema são aditivas e os dados atuais permanecem.
Essa execução não é uma transação única: cada instrução é aplicada separadamente. Interrupções podem deixar o esquema parcialmente atualizado até a retomada.
Os testes locais cobrem banco novo, legado, parcialmente migrado, preservação de conta/bio e segunda execução sem alterações.

Pós-publicação: consultar `/health` nos dois Workers; verificar que `/servers`, `/ice` e upload sem sessão retornam 401; confirmar `db:plan` sem pendências.
Fluxos autenticados contra produção precisam de uma sessão legítima obtida pelo usuário no app; não buscar tokens em logs ou configurações para fabricar o teste.
Teste físico entre redes continua pendente.

## Contratos revisados e correções

Hub HTTP: os contratos de `HubApi` do Qt para listar/criar servidores, criar/aceitar convite e obter ICE correspondem ao backend.
Qt usa duração conservadora de 280 s para credenciais ICE, com atualização de 240 s; compatível com cache de até 300 s e TTL de 600 s no hub.

Dois bloqueios de sinalização foram corrigidos no backend e testados:

1. Um membro entra no WebSocket do seu servidor com a sessão do handshake, sem convite do grupo legado. Essa identidade permanece fixa para o socket e não pode ser substituída por outro token no payload.
2. Conexões legadas aceitam `sessionToken` também em `userData`, formato enviado pelo cliente Qt atual.

O encaminhamento Worker → Durable Object usa identidade interna; o Worker remove qualquer cópia externa do cabeçalho antes de encaminhar. Testes confirmam rejeição de cabeçalho forjado, associação obrigatória e preservação da proteção do grupo legado.

### Correção aplicada no cliente após o Claude terminar

Em `desktop/src/auth_session.cpp`, `AuthSession::validateAsync()` usa `const auto account = doc.object();`, mas `/me` retorna `{account: {...}}`.
Alteração necessária:

```cpp
const auto account = doc.object().value("account").toObject();
```

Além disso, para que a remoção do avatar se reflita no cache, `avatar_url: null` precisa limpar a URL local; usar `toString(avatarUrl_)` preserva a imagem antiga nesse caso. Sugestão:

```cpp
if (account.contains("avatar_url")) avatarUrl_ = account.value("avatar_url").toString();
```

Depois de confirmar a conclusão da rodada do Claude e a ausência de builds Qt em execução, Codex aplicou essas duas correções em `desktop/src/auth_session.cpp`. O novo teste `validateRefreshesNestedAccountAndClearsRemovedAvatar` em `desktop/tests/google_auth_tests.cpp` usa HTTP local para verificar resposta aninhada, atualização de nick/ID/email, remoção de avatar e persistência. Nenhum commit foi feito no checkout nativo compartilhado.

Build `-DevTools` passou. Na execução completa, as onze outras suítes CTest passaram, incluindo 51 testes de UI; o novo teste de autenticação inicialmente falhou por comparar o nome de um cabeçalho HTTP com distinção de maiúsculas. A asserção foi corrigida e a suíte `native-google-auth` passou em nova execução. O defeito estava na asserção, não no envio da autorização.

Upload/renderização do avatar e banner ainda não aparecem no editor Qt inspecionado. O contrato do backend está em `BACKEND_HANDOFF.md`; os campos de texto e a prévia já existentes não substituem essa integração.

## Verificação local desta rodada

`npm test` passou em `cloudflare-auth` e `cloudflare`, incluindo os dois builds dry-run.

```text
PASS: migration plans for empty, legacy and partially migrated D1; account/profile preservation; second-run no-op; incompatible schema rejected
PASS: Qt nested session contract, pinned server identity, forged-header rejection, member handshake without a legacy invite or INVITE_CODE
```

Situação final: migração remota, publicação e verificações públicas concluídas. Permanecem pendentes os fluxos autenticados no app real, upload/renderização de imagens no editor Qt e chamada física entre redes.
