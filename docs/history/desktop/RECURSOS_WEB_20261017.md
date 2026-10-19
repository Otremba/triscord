# Recursos do cliente C++/WebView2 — 17/10/2026

Rodada válida: `out/web-resource-report/20261017T165534Z/summary.json`, `passed: true`, dez verificações aprovadas, oito ciclos de chamada. Artefatos locais ignorados pelo Git: relatório, amostras CSV/JSON e logs. Procedimento reproduzível: `tests/e2e/RESOURCE_BENCHMARK.md`.

## Resultado

Valores do cliente principal Alice, incluindo sua árvore completa de processos WebView2. Memória em MiB; valores de memória são medianas das amostras. Na linha de chamada, agregam-se as oito janelas de seis segundos. O cliente Bob, Workers e Python são excluídos destes números; Bob tem medição própria no relatório.

| Etapa | Privada comprometida | Working set somado | Privada só do host C++ | CPU média (um núcleo = 100%) |
| --- | ---: | ---: | ---: | ---: |
| Repouso inicial (15 s) | 227,1 | 421,7 | 43,4 | <0,01% |
| Chamada com câmera remota (48 amostras) | 311,6 | 480,5 | 63,9 | 4,09% |
| Repouso após oito ciclos (15 s) | 255,6 | 460,3 | 47,9 | 0,10% |
| Janela minimizada (21 amostras) | 241,6 | 459,5 | 47,9 | 0,07% |
| Repouso após restaurar (15 s) | 256,3 | 459,6 | 47,9 | <0,01% |

Pico privado de todo o ensaio: **331,2 MiB**, durante o editor de perfil. Nas chamadas: CPU p95 de 21,12% de um núcleo; média de 0,34% e p95 de 1,76% quando normalizadas pelos 12 processadores lógicos desta máquina. O repouso posterior retém aproximadamente **28,5 MiB** privados acima do inicial; depois de restaurar, a diferença é 29,2 MiB. Os repousos finais ficam próximos entre si, mas esta única rodada curta não demonstra ausência de vazamentos. O working set somado pode contar páginas compartilhadas mais de uma vez; não corresponde a RAM física exclusiva do app.

## Carga e validação

Windows 11, build 26200, 12 processadores lógicos, WebView2 155.0.4283.60, psutil 7.2.2. Executável SHA-256 `00852ab030744f60602056bf1bdd172a73f18853702a49e6161ff9650c096ac4`. Amostragem a cada segundo e sondas a cada cinco segundos; cerca de cinco minutos de cenário. Perfis de configurações e dados de navegador separados por conta, sem compartilhar a árvore WebView2.

Workers reais locais, D1 descartável e Google simulado. Avatar PNG de 320×320 (307.965 bytes); banner GIF de 400×140, oito frames (4.986 bytes). Alice abre/fecha o editor de perfil, oculta/mostra o vídeo e deixa/reentra na sala em cada ciclo. Bob confirma oito ativações de câmera. Cada chamada tem dois participantes e vídeo nativo desenhado; a saída exige streams vazios. Ao terminar, nenhuma chamada, editor ou tela cheia fica ativo.

Fonte de câmera sintética de 640×360, **recebida em 320×180 em todos os ciclos**; áudio injetado silencioso. Portanto, os números não representam captura física, 1080p, qualidade/latência de áudio ou WAN. Memória dedicada da GPU não foi medida. Os contadores de desenho confirmam a janela nativa funcionando, não são medição de FPS ou fluidez.

## Correções e diagnóstico

O núcleo web passou a esperar a prontidão da mídia antes de iniciar a câmera. Expõe ativação pendente/cancelável e prazo de dez segundos; sair/desconectar limpa a intenção de ligar. Frames atrasados sem chamada ou sem participante atual são rejeitados, e frames locais de câmera não voltam após cancelamento. A fonte sintética roda somente quando o publicador confirma a ativação.

O teste também foi corrigido: a janela Bob é minimizada, e o navegador pode suspender temporizadores JavaScript. Bob agora acompanha eventos do estado nativo, sem depender de polling para confirmar entrada e câmera. Dados WebView2 de testes ficam sob `TRISCORD_SETTINGS_PATH`; instâncias normais mantêm seu diretório habitual.

As rodadas `20261017T164055Z`, `20261017T164953Z` e `20261017T165348Z` falharam e ficam preservadas para diagnóstico. Não foram usadas nos resultados acima. Não houve deploy, commit ou substituição do pacote Qt da Área de Trabalho.


## Regressões após a medição

Typecheck e build da interface passaram. E2E de chamada: 9/9, incluindo cancelamento sem stream residual e reinício da câmera. E2E de tela cheia/ocultação/troca de sala: 29/29. CTest relacionado: native-core, native-voice e native-camera, 3/3 suítes aprovadas. O teste local não substitui a validação física/WAN pendente.
