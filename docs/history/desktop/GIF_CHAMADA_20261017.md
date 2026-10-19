# GIF do próprio avatar na chamada

O cartão da chamada usava `VoiceUser.avatarUrl`, a miniatura PNG gerada pelo núcleo com o primeiro quadro do arquivo. O GIF original já estava validado e carregado em `session.profile.avatarDataUrl`, mas não era usado nesse cartão.

`CallView.ParticipantCard` agora usa esse GIF original para o próprio usuário. O WebView2 anima a imagem diretamente, sem reenvio de frames pela ponte ou downloads adicionais. Em PNG/JPEG, usa a miniatura atual de `session.account.avatarUrl`; isso também corrige a atualização/remoção imediata no cartão, antes dependente de uma nova publicação da lista da sala. Os thumbnails pequenos da conta/lateral e os perfis de terceiros mantêm o comportamento anterior. Não houve mudança no backend, na captura de câmera ou no tratamento de avatares remotos.

E2E `tests/e2e/run_web_animated_avatar_e2e.py`: conta/Workers/D1 locais, avatar GIF sintético de oito frames com uma faixa em movimento. O teste captura somente a própria janela do cliente e compara pixels no interior do avatar, sem anel de voz, texto, cursor ou controles. Foram observados **oito quadros distintos** na chamada e **oito após sair/reentrar**; a substituição por PNG produziu um único quadro estático. Upload, remoção e retorno ao GIF também passaram. Total: **13/13 verificações**. A versão final usa polling de diagnóstico de 1 s; o benchmark de recursos mantém o padrão anterior de 5 s.

Typecheck/build da interface e regressão da visão da chamada **29/29** passaram. Artefatos locais: `out/web-animated-avatar-e2e-report/result.json` e os recortes `gif-*.png`, `png-*.png`, `rejoin-*.png`. A primeira preparação do teste usou o grupo legado sem uma sala autenticada; o harness passou a criar um servidor privado. O teste também encontrou o refresh atrasado ao remover o avatar, corrigido pela fonte atual da conta.

A atualização é entregue por `scripts/portable-web.ps1`, que verifica os arquivos e o renderer do release e do portátil. A instância pessoal em chamada não é encerrada: o usuário deve reabrir o aplicativo quando puder para carregar os novos assets. Sem deploy de Workers ou commit.

## Sons (consulta feita durante a correção)

O soundboard tem reprodução nativa via QMediaPlayer, saída selecionada, volume e silenciamento ao desativar o áudio. Os avisos sonoros próprios de entrar/sair e ligar/desligar microfone ainda não foram implementados. Não foram acrescentados nesta correção de GIF nem testados em alto-falantes físicos nesta rodada.

Entrega concluída: `C:/Users/camargo/Desktop/triscord.exe`, SHA-256 `4007F04C3EC90461E44D489267BE6598F5A5C4B07ACBE2DEF343DECCED8A0661`, package ID `be111813c1dac34d2378`. Verificações do release 21/21 e do portátil 23/23 aprovadas; hash da cópia conferido. Backup web anterior em `out/desktop-backups/triscord-web-B0D942A1.exe`. A chamada pessoal em andamento foi preservada.
