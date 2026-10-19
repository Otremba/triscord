# Triscord — preferências e continuidade

## Instruções do usuário

- Commits diretamente na `main`, uma mudança coerente por commit. Não criar branches sem pedido.
- Mensagem curta em inglês, uma única linha `tipo: resumo`, em modo imperativo, começando em minúscula e sem ponto final.
- Tipos: feat, fix, docs, chore, refactor, test, perf, build, ci.
- Sem escopo, corpo, trailers, coautoria ou atribuições a assistentes. Não colocar versão na mensagem; tags nativas usam `desktop-vX.Y.Z`.
- Não reescrever histórico, apagar releases/deployments nem repetir o reset sem nova instrução explícita.
- Push, publicação de release e deploy precisam estar autorizados pelo pedido. Não inferir publicação de uma simples revisão.
- Na revisão atual, o usuário proibiu testes no computador. Não executar testes, E2E ou o aplicativo para validar. Compilação e empacotamento permanecem pendentes de pedido explícito.
- Não interromper o aplicativo instalado ou chamadas. Não versionar credenciais, SDKs, caches ou binários.
- Após um deploy autorizado, fazer logout do Wrangler, conforme pedido do usuário de 19/10/2026. Não afirmar revogação no servidor sem confirmação.

## Estado registrado em 19/10/2026

- Repositório: Otremba/triscord. Checkout principal: `C:/Users/camargo/Documents/GitHub/triscord`.
- O usuário resetou o histórico com o Claude; baseline `4116561`, bump `3905156`, docs `b029938`. Não reaplicar a história antiga.
- Release publicada: `desktop-v0.9.35`, com instalador e SHA-256, `make_latest: false`. Pacote sem validação em execução (`runtimeVerified=false`).
- O site é Cloudflare Pages, projeto `triscord`, branch de produção `main`, domínio `triscord.pages.dev`; upload direto, independente do push Git.
- Deploy de correção do site: `e4606892.triscord.pages.dev`. `/download` chega ao instalador com HTTP 200; o caminho removido da 0.9.32 responde 404, sem Content-Disposition de instalador. SHA-256 da 0.9.35: `1d4fde55eef0afb192b631be9612207edce96db54e429a3f3f39d511c52ff58a`. Wrangler foi deslogado e `whoami` confirmou ausência de autenticação.
- Em seguida foram incorporadas as correções locais de imagem e áudio (`5fed5cb`, `9e6f780`) e de links (`f24f745`). Elas ainda não estão no instalador publicado.
- A qualidade da prévia acompanha a resolução escolhida; bitrate não é dividido automaticamente por espectadores. A recuperação de áudio evita consumir PCM sem espaço na saída.
- Preferências individuais de áudio são locais por identidade de conta. Não afirmar sincronização entre computadores.
- Worktrees `native-desktop` e `backend-media` podem estar em commits antigos. Conferir status e preservar alterações antes de atualizar. A toolchain existente está em `C:/Users/camargo/.codex/worktrees/native-desktop/triscord/.toolchain`.
- O serviço legado Render pode criar um registro de deployment a cada push. Apagar registros não desabilita a integração; não repetir a exclusão como rotina.

Esta memória foi consolidada da conversa do Claude Code `66a8637f-6d60-4f38-b809-32308939d7f7` e da conversa atual. Resultados de testes antigos do Claude são históricos, não validação das alterações posteriores.
