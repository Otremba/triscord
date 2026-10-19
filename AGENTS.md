# Triscord — preferências e continuidade

## Instruções do usuário

- Commits diretamente na `main`, uma mudança coerente por commit. Não criar branches sem pedido.
- Mensagem curta em inglês, uma única linha `tipo: resumo`, em modo imperativo, começando em minúscula e sem ponto final.
- Tipos: feat, fix, docs, chore, refactor, test, perf, build, ci.
- Sem escopo, corpo, trailers, coautoria ou atribuições a assistentes. Não colocar versão na mensagem; tags nativas usam `desktop-vX.Y.Z`.
- Não reescrever histórico, apagar releases/deployments nem repetir o reset sem nova instrução explícita.
- Push, publicação de release e deploy precisam estar autorizados pelo pedido. Não inferir publicação de uma simples revisão.
- Na revisão atual, o usuário proibiu testes no computador. Não executar testes, E2E ou o aplicativo para validar. O pedido posterior autorizou compilar, empacotar e publicar a 0.9.36, sem testes nem execução do aplicativo/instalador.
- Não interromper o aplicativo instalado ou chamadas. Não versionar credenciais, SDKs, caches ou binários.
- Após um deploy autorizado, fazer logout do Wrangler, conforme pedido do usuário de 19/10/2026. Não afirmar revogação no servidor sem confirmação.

## Estado registrado em 19/10/2026

- Repositório: Otremba/triscord. Checkout principal: `C:/Users/camargo/Documents/GitHub/triscord`.
- O usuário resetou o histórico com o Claude; baseline `4116561`, bump `3905156`, docs `b029938`. Não reaplicar a história antiga.
- Release publicada: `desktop-v0.9.36` (commit `3172188`), com instalador e SHA-256, `make_latest: false`. Pacote sem validação em execução (`runtimeVerified=false`).
- O site é Cloudflare Pages, projeto `triscord`, branch de produção `main`, domínio `triscord.pages.dev`; upload direto, independente do push Git.
- Deploy atual: `6124981e.triscord.pages.dev`. `/download` entrega o instalador 0.9.36 com HTTP 200; o arquivo baixado e o checksum público correspondem ao pacote. SHA-256: `01b3d5b8cf31c67e333547bb62819aaf9c2bfb8a7c80f227fab788b623f521ef` (43.623.900 bytes). Wrangler foi deslogado e `whoami` confirmou ausência de autenticação.
- As correções de imagem e áudio (`5fed5cb`, `9e6f780`) e de links (`f24f745`) estão publicadas. Compilação/empacotamento concluídos com `-SkipRuntimeVerification`, sem testes ou execução do app/instalador. O atualizador nativo consulta a lista pública de releases ao iniciar; a 0.9.36 está disponível com instalador e checksum. Electron antigo continua sem ponte automática de migração.
- Na 0.9.36 a transmissão ficou presa em "Conectando à transmissão…" para quem assiste: o log de quem transmitia mostrava pedidos seguidos de keyframe ("viewer losses") e o bitrate caindo de 12 Mbps até o piso. Causa provável (sem o log de quem assistia): keyframes grandes demais para os 256 pacotes guardados para reenvio. Na `main`, ainda não publicado: bitrates de volta aos da 0.9.35 (1080p60 8 Mbps, 720p30 2,5 Mbps), histórico de reenvio de 2048 pacotes e prévia local de volta a 640x360. O bitrate continua sem divisão por espectadores. A recuperação de áudio evita consumir PCM sem espaço na saída.
- Preferências individuais de áudio são locais por identidade de conta. Não afirmar sincronização entre computadores.
- Worktrees `native-desktop` e `backend-media` podem estar em commits antigos. Conferir status e preservar alterações antes de atualizar. A toolchain existente está em `C:/Users/camargo/.codex/worktrees/native-desktop/triscord/.toolchain`.
- O serviço legado Render pode criar um registro de deployment a cada push. Apagar registros não desabilita a integração; não repetir a exclusão como rotina.

Esta memória foi consolidada da conversa do Claude Code `66a8637f-6d60-4f38-b809-32308939d7f7` e da conversa atual. Resultados de testes antigos do Claude são históricos, não validação das alterações posteriores.
