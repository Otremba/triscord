# Triscord — preferências e continuidade

## Instruções do usuário

- Commits diretamente na `main`, uma mudança coerente por commit. Não criar branches sem pedido.
- Mensagem curta em inglês, uma única linha `tipo: resumo`, em modo imperativo, começando em minúscula e sem ponto final.
- Tipos: feat, fix, docs, chore, refactor, test, perf, build, ci.
- Sem escopo, corpo, trailers, coautoria ou atribuições a assistentes. Não colocar versão na mensagem; tags nativas usam `desktop-vX.Y.Z`.
- Não reescrever histórico, apagar releases/deployments nem repetir o reset sem nova instrução explícita.
- Push, publicação de release e deploy precisam estar autorizados pelo pedido. Não inferir publicação de uma simples revisão.
- Testes: em 19/10 o usuário liberou rodar o app e os testes para testar e corrigir (antes tinha proibido). Rodar o app só com perfil isolado (`TRISCORD_SETTINGS_PATH`) e build próprio; nunca interromper o app instalado nem chamadas.
- Não interromper o aplicativo instalado ou chamadas. Não versionar credenciais, SDKs, caches ou binários.
- Após um deploy autorizado, fazer logout do Wrangler, conforme pedido do usuário de 19/10/2026. Não afirmar revogação no servidor sem confirmação.

## Estado registrado em 19/10/2026

- Repositório: Otremba/triscord. Checkout principal: `C:/Users/camargo/Documents/GitHub/triscord`.
- O usuário resetou o histórico com o Claude; baseline `4116561`, bump `3905156`, docs `b029938`. Não reaplicar a história antiga.
- Release publicada: `desktop-v0.9.37` (commit `4abd01f`), com instalador e SHA-256, `make_latest: false`, empacotada com verificação em execução (`runtimeVerified=true`). Releases anteriores mantidas: `desktop-v0.9.36` e `desktop-v0.9.35`.
- O site é Cloudflare Pages, projeto `triscord`, branch de produção `main`, domínio `triscord.pages.dev`; upload direto, independente do push Git.
- Deploy atual: `34fd576e.triscord.pages.dev`. `/download` entrega o instalador 0.9.37 com HTTP 200; o arquivo baixado e o checksum público correspondem ao pacote. SHA-256: `d70f40319143c8bf625b906e2c253772313f756f796354e1dbec40550d11e49d` (43.628.258 bytes). Links de versões antigas respondem 404. Wrangler foi deslogado e `whoami` confirmou ausência de autenticação.
- A 0.9.37 traz: vídeo da transmissão de volta ao da 0.9.35 (1080p60 8 Mbps, 720p30 2,5 Mbps, prévia 640x360, reenvio de 256 pacotes); teto total de upload de 16 Mbps dividido entre espectadores (`kScreenUploadBudget`); log com horário em cada linha, avisos do Qt (antes iam para o depurador e se perdiam), motivo das quedas de conexão (`signaling: ...`), motivo dos pedidos de keyframe (`video: asked the sender for a keyframe: ...`) e sem o ruído do FFmpeg. Com `TRISCORD_SETTINGS_PATH`, o log vai para `<pasta>/logs`, sem rotacionar o log do app instalado. A correção de áudio da 0.9.36 (`9e6f780`) continua. CTest 12/12 e o novo `tests/e2e/run_web_screen_share_e2e.py` (1080p60 por localhost, primeiro quadro em ~160 ms) passaram; o caminho por relay TURN não foi testado (o `/ice` de produção exige sessão de conta).
- Abertos: na 0.9.36 a transmissão ficou presa em "Conectando à transmissão…" para quem assistia por relay; quem assistia teve 0 pacotes irrecuperáveis, então o pedido de keyframe nasce no cliente dele (fila de quadros, quadro incompleto ou decodificador), causa exata desconhecida; a 0.9.37 volta o vídeo ao da 0.9.35 e registra o motivo. Também sem causa conhecida, agora registrados no log: laço de reconexão de voz ("voice: connection restored" repetido) e falha ao iniciar o compartilhamento.
- Preferências individuais de áudio são locais por identidade de conta. Não afirmar sincronização entre computadores.
- Worktrees `native-desktop` e `backend-media` podem estar em commits antigos. Conferir status e preservar alterações antes de atualizar. A toolchain existente está em `C:/Users/camargo/.codex/worktrees/native-desktop/triscord/.toolchain`.
- O serviço legado Render pode criar um registro de deployment a cada push. Apagar registros não desabilita a integração; não repetir a exclusão como rotina.

Esta memória foi consolidada da conversa do Claude Code `66a8637f-6d60-4f38-b809-32308939d7f7` e da conversa atual. Resultados de testes antigos do Claude são históricos, não validação das alterações posteriores.
