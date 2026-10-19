# Falhas, recuperação e sessão de sockets — 16/10/2026

Escopo: backend usado pela branch C++/Qt. Claude mantém os testes visuais do executável em `desktop/tests/e2e/`; esta rodada não modifica nem compila o cliente.

Executar a partir de `cloudflare/`, com dependências instaladas nos dois pacotes:

```powershell
npm run test:recovery
```

O comando faz exclusivamente dry-run dos dois bundles em `out/recovery/`, sem disputar o `out/worker.js` de outros testes. Depois roda `recovery.test.mjs` e `turn-recovery.test.mjs`. Miniflare/workerd, D1, SQLite do Durable Object e provedor HTTP são locais. Cada execução tem banco descartável. Nenhuma chamada ao provedor TURN real ou alteração em produção.

## Bug reproduzido e política de revogação

Antes da correção, o teste fez logout pelo Worker auth real e tentou enviar outra mensagem pelo WebSocket existente. A conexão permaneceu aberta e continuou autorizada com a identidade antiga; o teste falhou com `Revoked socket remained open`.

Agora o hub consulta sessão e, nos servidores, associação do membro antes de processar cada pacote autenticado. Sessão expirada, apagada ou associação removida encerra o socket com **1008**, remove presença e impede o comando. O fluxo legado de convite também fica vinculado à sessão quando o usuário entra autenticado; não passa a convidado depois do logout. As mensagens com identidade falsa continuam usando a conta validada na conexão.

O alarme de heartbeat revalida os sockets ociosos, nominalmente a cada **25 s**. **Não há notificação instantânea entre auth e todos os Durable Objects:** um socket ocioso revogado pode continuar recebendo broadcasts até a próxima execução do alarme; agendamento do runtime pode acrescentar atraso. Comandos cuja autorização já estava em andamento no instante do logout não têm cancelamento transacional. A suíte aciona o handler real de alarme pela fixture, sem aguardar a agenda de produção; não mede um SLA de 25 s.

Apenas hash da sessão/identidade e serverId ficam no attachment de hibernação; o token bearer não é persistido ali. Attachments antigos autenticados sem hash são recusados e precisam reconectar. Isso não desconecta diretamente pares WebRTC já estabelecidos: encerramento efetivo da mídia após queda da sinalização pertence ao cliente e ainda precisa ser validado.

## Falhas e recuperação cobertas

- Logout com socket aberto: próximo comando recusado, presença removida e mensagem posterior ausente do histórico.
- Expiração no alarme, remoção de membro e sessão autenticada no fluxo legado.
- **Evicção real via API do Miniflare, com hibernação dos sockets:** o mesmo cliente volta a reagir à mensagem sem reconectar; identidade, histórico e presença única são restaurados.
- Falha D1 simulada renomeando temporariamente a tabela de sessões: auth/hub devolvem JSON **503/service_unavailable**; socket autenticado fecha com **1013**, permitindo nova tentativa. Restaurar a tabela permite reconexão sem perda do histórico. É uma falha de consulta local, não uma simulação de latência/indisponibilidade regional do serviço hospedado.
- Reinício completo do runtime local, usando a mesma pasta temporária de persistência: sessão, associação D1 e histórico SQLite continuam utilizáveis.
- TURN: HTTP de erro, JSON quebrado, URLs inválidas, credenciais ausentes, falha de rede e corpo HTTP que começa e não termina. Todos devolvem **502/turn_unavailable**, sem detalhes do provedor e sem cachear a falha. Timeout de **5 s** abrange leitura do JSON.
- Recuperação do provedor: doze requisições simultâneas compartilham uma emissão; a seguinte usa cache válido. Revogar a sessão impede acesso mesmo com cache preenchido.

## Mudanças e custo

`cloudflare/src/worker.js`: revalidação de sockets, remoção da interpretação de falha D1 como sessão ausente, respostas sanitizadas de erro, limite temporal e validação estrutural da resposta TURN, compartilhamento de emissão em andamento. `cloudflare-auth/src/worker.js`: falhas inesperadas retornam 503 sanitizado em vez de detalhes internos.

A revalidação acrescenta uma consulta indexada por sessão e uma por associação em cada pacote de conta/servidor, além da revisão periódica. Ela prioriza revogação consistente em vez de cachear autorização; carga e custos de D1 em produção ainda não foram medidos. O cache TURN continua por isolate, não global.

## Validação e limites

`npm run test:recovery` passou. Os testes existentes de hub, auth, mídia e migrações passaram usando os bundles exclusivos desta rodada. O E2E HTTP dos dois Workers/D1 também passou; o caso Qt foi explicitamente omitido nesta rodada para não disputar o build/E2E visual do Claude. Variáveis `TRISCORD_CONTROL_TEST_BUNDLE` e `TRISCORD_AUTH_TEST_BUNDLE` permitem apontar essas suítes a bundles alternativos (usar caminhos absolutos).

O workflow nativo inclui `test:recovery` no job Linux; não foi executado no GitHub. Não foram feitos deploy, migração, commit ou atualização do executável. Ficam pendentes staging, carga prolongada, falhas de escrita com rollback/quota, perdas/latência de rede, WAN/TURN real, revogação de mídia P2P e uma política de notificação imediata de logout, se necessária.
