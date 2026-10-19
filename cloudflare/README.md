# Servidor privado na Cloudflare

Este Worker substitui a sinalização Socket.IO do servidor Node para clientes
nativos. Salas, texto (últimas 200 mensagens), reações, presença e moderação
usam um Durable Object SQLite com WebSockets hibernáveis. Voz e H.264 seguem
diretamente entre participantes por ICE/DTLS-SRTP; o Worker não recebe mídia.

## Testar sem conta

Node.js 22 ou superior, na pasta `cloudflare`:

```powershell
npm ci
npm test
```

Os testes usam Miniflare, um convite fictício e armazenamento temporário.
Para testar também três clientes C++ com voz e vídeo sintéticos, coloque os
binários Qt/MinGW no PATH e defina `TRISCORD_NATIVE_SCREEN_SMOKE` como o caminho
absoluto de `desktop/out/build/triscord-screen-room-smoke.exe` antes de `npm test`.
Eles exigem entrega de mídia, reentrada com nova sessão e parada da transmissão.

## Publicar

Use uma conta no plano Workers Free. Não habilite upgrade automático nem serviços
Realtime/TURN pagos. Confira o plano no painel antes de publicar.

```powershell
npx wrangler login --use-keyring --scopes account:read user:read workers_scripts:write
npm run build
npm run deploy
npx wrangler secret put INVITE_CODE
```

O login abre o consentimento oficial do Wrangler; o token fica no cofre do
Windows quando `--use-keyring` está disponível. `secret put` pede um código
privado: use um valor aleatório com pelo menos 16 caracteres, guarde-o e
compartilhe somente com os amigos. Não coloque tokens nem o convite no Git.
Até configurar esse segredo, a conexão WebSocket responde 503 e não aceita clientes; `/health` ainda responde HTTP 200.

No cliente, informe a URL HTTPS exibida pelo deploy e o código do grupo.
O código salvo localmente é protegido pelo DPAPI do Windows. Todos precisam
usar a prévia nativa; a interoperabilidade com Electron não foi aceita.

### Aceitação do serviço publicado

Defina `TRISCORD_TEST_INVITE` somente no ambiente do terminal de teste, sem
imprimir seu valor. Execute explicitamente:

```powershell
node tests/remote.test.mjs https://SEU-WORKER.workers.dev
# No diretório raiz, com Qt/MinGW no PATH:
./desktop/out/build/triscord-screen-room-smoke.exe --cloudflare https://SEU-WORKER.workers.dev
```

O primeiro verifica HTTPS, convite, texto, reação e um ciclo real de heartbeat.
O segundo conecta três clientes C++ com voz/vídeo sintéticos, sem abrir microfone
ou capturar a tela. O modo remoto exige uma URL HTTPS `workers.dev`, convite e
o argumento explícito `--cloudflare`; o modo padrão continua restrito a localhost.
Ambos usam a sala separada `native-validation` (que permanece no diretório) e
adicionam somente dados de teste. Não são executados pelo CI nem por `npm test`.
Mídia direta entre processos do mesmo PC não valida NAT nem qualidade em redes
diferentes: o teste com o amigo ainda é necessário.

A permissão OAuth específica para publicação é `workers_scripts:write`, que
inclui scripts e Durable Objects. A permissão `workers:write` não foi suficiente
para a API de deployments nesta versão do Wrangler; não use o login padrão que
solicita também permissões de serviços não utilizados.

## Limites e gratuidade

O serviço limita o grupo a 16 conexões, oito salas e dez pessoas por sala.
Pacotes de controle têm até 256 KiB; cada conexão aceita até 40 eventos/s.
Há um orçamento de 24.000 eventos autenticados por dia; ao esgotar, operações
são recusadas com uma mensagem simples. Esse orçamento reduz trabalho e escrita
em SQLite, mas não substitui os limites de plataforma nem protege contra todos
os tipos de abuso. Não há ativação de cobrança ou mudança de plano pelo código.

Durable Objects no plano Free exigem SQLite. Confira os limites atuais na
[documentação oficial](https://developers.cloudflare.com/durable-objects/platform/pricing/).
Hibernação evita manter a instância executando durante silêncio, mas heartbeat,
mensagens e chamadas de controle ainda consomem a franquia.

STUN é fornecido para descoberta de conexão direta. **TURN não está configurado**:
redes com NAT restritivo podem impedir voz/tela, mesmo com salas e chat funcionando.
Não prometemos conectividade universal gratuita; relay, adaptação de qualidade e
aceitação com dois PCs em redes diferentes continuam necessários.

Não há diagnóstico, histórico de CPU/RAM/GPU, captura de mídia ou painel público.
`/health` expõe apenas a disponibilidade HTTP, não dados do grupo.
