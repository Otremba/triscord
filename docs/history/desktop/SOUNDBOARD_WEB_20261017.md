# Retomada do soundboard web — 17/10/2026

Claude Code parou na sessão `5becb7cd-c35f-421d-8f5c-a638bd21958d`, após o pedido humano de observar o soundboard e implementá-lo no cliente web. Esta entrega continua essa tarefa, preservando a interface Qt distribuída. Não houve commit nem deploy.

## Implementação

- Botão na barra da chamada e no painel de voz da conta. Popover ancorado, 532×522 limitado à janela; busca, seção do servidor recolhível, grade de três colunas, rolagem, Escape/clique fora e devolução de foco. Catálogo real de 32 sons já empacotados no Triscord; não inclui servidores/sons do Discord, compras ou funções sem suporte.
- Clique principal envia `soundboard-play` pelo núcleo e reproduz o evento `soundboard-played` da sala, inclusive o próprio eco. Prévia é um comando distinto e exclusivamente local, acionado pelo botão secundário; passar o mouse sozinho não reproduz áudio. Regras de foco/hover revelam essa ação sem prefixar nomes com emojis genéricos.
- `SoundPlayer` é QObject sem Widgets: reprodução QMediaPlayer/QAudioOutput, recurso local verificado pelo hash do catálogo, remoção de metadados ID3 como no cliente Qt, cache com QSaveFile, saída escolhida nas configurações e volume do soundboard já persistido (padrão 70%). Um som por vez; prazo máximo de 10,5 s. A tela web não ganhou uma página de volume nova nesta rodada.
- Desativar áudio interrompe e suprime reprodução. Sair, desconectar, mudar de sala ou receber expulsão interrompe o som. Fechar o popover para apenas a prévia local, preservando um som da sala que ainda toca.
- Ponte limita campos/IDs ao catálogo e bloqueia broadcast sem sessão, fora de chamada, sem conexão, com áudio desativado ou com intervalo inferior a um segundo. O hub mantém sua validação independente. Nenhum endpoint novo foi necessário.
- Popover suspende/restaura overlays nativos de vídeo pelo mecanismo existente, evitando que a superfície nativa cubra os controles. Isso é a adaptação atual do caminho A, não composição DOM/vídeo comprovadamente idêntica ao Discord.

## Evidência e fidelidade

Referência visual anterior: `out/reference/discord-sb-3-open.png`, SHA-256 `78792c5b9e55285e322a081c2083cddeddc4ebd2bb345b57ce7bd10f749e04c4`, conferido nesta retomada. Medidas/estado original: `out/claude-observations/SOUNDBOARD.md` (15/10). O tema usa tokens atuais do cliente web; as cores adaptadas antigas dessa observação não foram adotadas como novas medições.

REA retida: `out/codex-coordination-20261014/rea-settings-soundboard/HANDOFF.md`, módulos 511558 (grade/categorias), 817232 (cartão/ação secundária de prévia), 194567 (ordem/disponibilidade). Evidências `ev_b5548ed5b3c3fef253e2fd63573a50e50a4bac21ede34b47664815eb1026500d` e `ev_217c88469aca0e264fdbf11c2371876dbd9cdc209c1a1aac42585602cd1f354f`. Não foi feita uma nova decompilação nesta rodada. Layout/cores da ação secundária web são uma adaptação a partir dessa evidência, sem nova medição completa do hover.

Observação atual pelo Computer Use: Discord 1.0.9262 já estava em voz com apenas o próprio usuário visível e microfone silenciado. Abrimos somente o painel e o fechamos com Escape; nenhum som foi tocado, nenhuma pessoa foi contatada. A árvore de acessibilidade mostrou busca “Encontre o som perfeito”, botão de volume, categorias, controles de tocar e oferta Nitro. A captura de janela não mostrou o popover apesar de a árvore mostrar o diálogo, portanto **não é um novo par visual aceito nem prova pixel perfect**. Usamos a referência salva acima. O estado de voz existente foi preservado.

## Verificação

`npm run typecheck` e `npm run build` em `desktop/web` passaram. Build CMake `triscord-web` passou; recursos do catálogo estão no alvo com AUTORCC.

Novo `tests/e2e/run_web_soundboard_e2e.py`: duas instâncias reais do WebView2/núcleo C++, dois Workers locais, D1 compartilhado, contas descartáveis e áudio injetado **silencioso**. Nove verificações passaram: fluxo completo; tamanho do popover; catálogo/busca; isolamento da prévia; broadcast recebido; desativação de áudio; ID inválido; limite de frequência; Escape/foco. Relatórios/capturas em `out/web-soundboard-e2e-report/`. Esse teste confere roteamento/estado, integridade dos recursos e UI, **não audibilidade nem decodificação física** do novo player; essa parte segue pendente.

Regressões E2E `run_web_call_e2e.py` e `run_web_settings_e2e.py` passaram: participantes/câmera/overlays, configurações, tema, troca de nome, saída e persistência. Nenhuma execução usa a conta ou sessão reais do usuário.

## Como abrir

Da raiz do checkout nativo:

```powershell
./desktop/scripts/run-web.ps1
```

É o cliente web de desenvolvimento (`out/build/triscord-web.exe`, assets em `web/dist`), ainda separado do Qt Widgets. O executável da Área de Trabalho **não foi substituído** por esse preview. O launcher usa as configurações normais do app e não habilita devtools. Para teste isolado, usar o harness E2E acima, que define perfil e backend locais próprios.

Ficam pendentes comparação visual completa do hover/preview/sem resultados, teclado de grade equivalente ao Discord, medição nova de memória e reprodução física. Sem afirmação de paridade integral, novo orçamento aprovado ou pacote web de distribuição concluído.
