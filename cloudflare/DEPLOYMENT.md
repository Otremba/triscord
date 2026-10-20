# Implantação aceita — 12/10/2026

Servidor: https://triscord-control.triscord-cloudflare-control.workers.dev

## Atualização P2P — 13/10/2026

Cliente 0.7.1 e Worker publicados sem transporte Realtime. A integração, os
testes exclusivos e os segredos do retransmissor foram removidos. O aplicativo
Realtime do triscord foi excluído e a renovação da assinatura foi cancelada.
Workers Free permanece ativo para salas, participantes, chat e sinalização.

Validação: oito suítes nativas, regressões de voz com dez clientes, tela e voz
simultâneas com três clientes e nova sessão após reentrada. O teste P2P com
sinalização no Worker publicado também passou, com a mídia entre processos no
mesmo PC. Continua pendente o teste entre redes de dois computadores reais.

Sem TURN, determinadas redes podem impedir a conexão P2P. O upload de quem
compartilha aumenta com o número de espectadores. Não há serviço de mídia
cobrado por tráfego no aplicativo.

- Worker `triscord-control`, Durable Object SQLite `TriscordHub`.
- Plano da conta verificado no painel: **Workers Free / $0**.
- Salas e chat usam Workers Free e Durable Objects SQLite. Voz e tela são P2P; não há integração com Realtime, TURN pago, R2 ou observabilidade permanente.
- Convite configurado como segredo `INVITE_CODE` na Cloudflare. A cópia local
  está em `desktop/out/cloudflare-group-invite.txt`, ignorada pelo Git. O pacote
  específico 0.6.1 embute esse valor para entrada automática; quem possui o
  executável pode entrar no grupo. Não copie o segredo para este documento
  nem para os fontes versionados.
- Credenciais do Wrangler protegidas no cofre do Windows. A permissão específica
  de publicação aprovada é `workers_scripts:write`; não é necessário conceder
  permissões de todos os serviços sugeridos pelo login padrão.

## Validação executada

HTTPS `/health`, WebSocket público, rejeição de convite inválido, autenticação,
entrada em sala, texto, reação e ciclo real de heartbeat aprovados pelo teste
separado `tests/remote.test.mjs`.

Três clientes C++ trocaram quadros H.264 decodificados e áudio Opus sintéticos
usando a sinalização desse Worker, com reentrada/nova sessão e parada de um
compartilhamento. Mídia ficou entre processos do mesmo PC, sem abrir microfone
ou capturar aplicativos. Esse teste não comprova travessia de NAT entre duas
redes, qualidade da fala, latência com um amigo ou desempenho do cliente completo.

O pacote Windows 0.6.0 iniciou e rejeitou os comandos de desenvolvimento. Seu
conteúdo contém apenas o cliente, dependências de execução e licenças. Novas
instalações sugerem esse servidor. Na versão 0.6.1 específica para o grupo,
servidor e convite são automáticos, com distribuição em um só `Triscord.exe`.
Extração, abertura real do cliente e reutilização da pasta de execução foram
testadas; a configuração compilada autenticou e trocou chat com o Worker.

## Próxima aceitação

Siga [o roteiro com um amigo](../docs/history/desktop/TESTAR_COM_AMIGO.md). O Worker controla
as salas; voz/tela usam mídia direta e STUN. TURN está ausente, então redes
restritivas podem impedir a mídia. Áudio do sistema, adaptação de qualidade e
os demais recursos mantidos ainda precisam de implementação/aceitação.

O limite diário local interrompe operações; no plano Free não habilitamos
cobrança para ultrapassar franquias. As cotas da plataforma são independentes
do orçamento do aplicativo e devem ser acompanhadas no painel da Cloudflare.

## Relatórios de erro — 20/10/2026 (ainda não implantado)

O aplicativo envia o log de uma sessão com sinais de bug para `POST /logs`
(`src/error_reports.js`); a página `/admin` lista e abre os relatórios com a
chave `ADMIN_KEY`. Antes de publicar o Worker com essa rota:

1. Criar o bucket R2 do binding `LOGS`: `npx.cmd wrangler r2 bucket create triscord-error-reports`
   (R2 entra no plano gratuito até 10 GB; os relatórios somem em 14 dias).
2. Aplicar a migração: `npx.cmd wrangler d1 execute triscord-accounts --remote --file migrations/0002_error_reports.sql`.
3. Definir a chave da página de admin (16 caracteres ou mais, guardada fora do repositório):
   `npx.cmd wrangler secret put ADMIN_KEY`.
4. `npx.cmd wrangler deploy` e conferir `/admin` com a chave.

Sem o bucket ou a chave, `/logs` e `/admin/api` respondem 503 e o aplicativo
apenas registra no log que o relatório não foi enviado.
