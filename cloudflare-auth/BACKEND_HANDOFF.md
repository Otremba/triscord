# Backend — entrega Codex, 16/10/2026

Atualização de integração/publicação: consulte `RELEASE_READINESS.md`. **Migrações e publicação concluídas com autorização explícita do usuário; plano remoto agora sem pendências e teste público passou.** Há um migrador que planeja/aplica somente alterações ausentes (`npm run db:plan` / `npm run db:migrate`), testes de compatibilidade com o payload Qt e correção do handshake de membros sem convite legado. O usuário renovou a autorização D1, resolvendo o bloqueio de acesso descrito no histórico abaixo. Após o Claude terminar, Codex também corrigiu a leitura de `/me` e remoção de avatar no cache do cliente, com teste de regressão; não houve commit no checkout nativo compartilhado. O texto abaixo preserva o estado da entrega inicial anterior à publicação.

Implementação baseada na conversa Claude Code `2ff05053-d87b-4924-8dab-fd459375f099` e no commit `1a1a0ed` da branch `rewrite/native-desktop`.
Codex alterou apenas `cloudflare/` e `cloudflare-auth/` no worktree `C:/Users/camargo/.codex/worktrees/backend-media/triscord`.
Cliente Qt, builds nativos e empacotamento permanecem com Claude Code. Nenhum deploy ou migração remota foi executado por Codex.

## API para integrar no Qt

Base: o mesmo Worker de autenticação usado em `/me` e `/profile`.

| Operação | Requisição | Resultado |
| --- | --- | --- |
| Enviar avatar | `PUT /profile/avatar`, `Authorization: Bearer <sessão>`, corpo binário, MIME real em `Content-Type` | `{ account, media }` |
| Enviar banner | `PUT /profile/banner`, mesmos cabeçalhos e corpo | `{ account, media }` |
| Remover | `DELETE /profile/avatar` ou `/profile/banner`, sessão obrigatória | `{ account }` |
| Mostrar imagem | `GET <media.url>`; público, sem sessão | bytes originais |

Exemplo do objeto `media`: `{ url, hash, size, mime, width, height, animated }`.
`account.avatar_url` e `account.banner_url` também retornam em `/me`, `/auth/google`, `PATCH /profile` e no perfil público `/profile/:id`.
URLs de mídia não são campos editáveis via `PATCH /profile`; use o upload binário. Não enviar multipart nem base64.
O servidor usa a identidade da sessão; o cliente não envia ID do proprietário no upload.

Formatos aceitos: PNG estático (`image/png`), JPEG (`image/jpeg`) e GIF (`image/gif`), incluindo GIF animado.
O MIME informado deve corresponder ao conteúdo. PNG animado/APNG, WebP e vídeo/MP4 não são aceitos nesta versão.
Não replicamos os prefixos privados `a_`/`v_` do Discord: a URL usa SHA-256 e a resposta declara a animação.
As evidências do Discord estão em `desktop/out/claude-observations/rea-css/PERFIL_BUNDLE.md` no checkout nativo; elas não demonstram que Qt já reproduz vídeo em perfis.

Limites próprios do Triscord, sem alegação de equivalência aos limites do Discord:

- Avatar: 524.288 bytes; banner: 1.048.576 bytes.
- Dimensões: até 4096×4096. GIF: até 200 quadros e 100 milhões de pixels acumulados.
- Armazenamento total de mídia: 64 MiB, máximo duas imagens atuais por conta.
- Substituir/remove libera os bytes antigos. Uma URL antiga passa a retornar 404; caches podem mantê-la por até cinco minutos.
- Remover avatar limpa a URL. O avatar do Google volta no próximo login; um avatar personalizado ativo é preservado em novos logins.
- Validação de contêiner e dimensões, sem decodificação completa dos pixels, transcodificação ou verificação antivírus.

Erros: `401 unauthorized`, `413 media_too_large` (inclui `max_bytes`), `415 unsupported_media`, `507 media_storage_full`. Envio inválido não muda o perfil.
O cliente deve mostrar o erro e manter a imagem anterior. Não tratar erro como upload concluído.

## Armazenamento e custo

Usa BLOBs no D1 existente, sem habilitar R2/Images ou qualquer assinatura nova.
D1 suporta até 2.000.000 bytes por linha/BLOB e 500 MB por banco no plano Free; os limites de upload e de armazenamento ficam abaixo disso.
Referência: https://developers.cloudflare.com/d1/platform/limits/ . Há também cotas de consultas e de requisições da plataforma; esta entrega não altera o plano da conta nem promete capacidade ilimitada.

A consulta somente leitura `wrangler r2 bucket list` falhou com erro de autenticação 10000. Isso não prova que R2 exige cartão nesta conta, nem que esteja habilitado.
Cloudflare Images oferece armazenamento somente no plano pago: https://developers.cloudflare.com/images/pricing/ .
Não foi solicitado cartão, renovado login ou ativado produto. D1 é uma opção inicial para grupo pequeno; objetos maiores exigem outra decisão de armazenamento.

## Hub: servidores e TURN

- Criação do servidor e associação do dono agora são uma transação.
- Aceitar convite é uma transação que contabiliza uso e cria associação juntos. Um membro repetindo um convite válido recebe 200 sem gastar outra utilização, mesmo se ele estiver esgotado. Expirados/desconhecidos retornam 410; um não membro continua sujeito a `maxUses`.
- Criar convite remove até 100 convites expirados daquele servidor. Não existe limpeza global agendada; servidores sem novos convites podem reter registros expirados.
- `/ice` mantém cache por isolate por cinco minutos e TTL de dez minutos. Cache compartilhado em Durable Object foi adiado: acrescentaria requisição/coordenação por chamada sem evidência de necessidade neste grupo. A autenticação ocorre antes de consultar o cache. Respostas HTTP usam `Cache-Control: no-store`.
- O contrato existente de `/servers`, `/invites/:code/accept` e `?serverId=...&sessionToken=...` permanece.

## Validação local

`npm test` em cada projeto executa também `npm run build` (`wrangler deploy --dry-run`). Ambos passaram em 16/10/2026, sem operações remotas.

Saída literal das suítes novas e existentes:

```text
PASS: google id_token verification, account upsert, sessions, nick uniqueness, logout, profile fields, profile migration idempotency
PASS: media authentication, ownership, PNG/GIF containers, animation budget, MIME spoofing, streamed size cap, byte round-trip, caching, replacement/deletion, public privacy, storage cap, profile key validation
PASS: private invite, native protocol, rooms/chat/reactions, typed signaling, role isolation, moderation and persistent bounded history
PASS: session-derived identity overrides client-sent names, expired/garbage sessions downgrade to clearly-marked guests, guests cannot claim registered nicks, missing-nick accounts get a placeholder
PASS: server directory, membership, invite creation/acceptance (atomic, expiry/max-uses enforced), owner-only invites, member-only server detail, per-server Durable Object isolation, legacy no-serverId connections still land on private-group-v1
PASS: GET /ice requires a session, returns stubbed iceServers, and caches the mint across requests (1 upstream call for 2 requests)
PASS: GET /ice upstream failure -> clean 502, no token or raw Cloudflare error body leaked
PASS: GET /ice with no TURN_API_TOKEN bound fails cleanly with 503, not a throw
```

Os testes de migração preservam uma conta antiga e reaplicam as migrações com um executor que tolera especificamente coluna duplicada.
Primeira execução do hub teve timeout na suíte preexistente de WebSocket; duas execuções seguintes passaram, sem alteração naquela seção. Continua sendo uma instabilidade observada do teste, não prova de conexão WAN.
Nenhum teste Qt ou chamada física foi executado por Codex.

## Publicação pendente após revisão

No mesmo banco `triscord-accounts`, verificar quais migrações já foram aplicadas. Para banco existente pré-perfil: `cloudflare/migrations/0001_servers.sql`, depois `cloudflare-auth/migrations/0002_profile.sql`, depois `cloudflare-auth/migrations/0003_media.sql`.
`0002` e os `ALTER TABLE` de `0003` devem ser aplicados uma única vez; os comandos Wrangler simples não ignoram coluna duplicada automaticamente.
Banco novo: `cloudflare-auth/schema.sql` já contém perfil e mídia; não reaplicar seus `ALTER TABLE`. Ainda precisa da migração de servidores.

Publicar os dois Workers somente após migrações necessárias e revisão. Os scripts `npm run deploy` fazem publicação real; `npm test` e `npm run build` fazem apenas dry-run.
A credencial OAuth atual do Wrangler não tem permissões D1/R2; a publicação/migração pode precisar de autorização apropriada do usuário. Nenhum segredo deve ser copiado para fontes ou para este documento.

Para conclusão integral: Claude integra upload/remoção e renderização estática/animada no perfil, conclui servidores e consumo de `/ice`, valida UI/CTest/pacote; depois são necessários migração/publicação e teste de voz/câmera/tela entre duas redes reais.
