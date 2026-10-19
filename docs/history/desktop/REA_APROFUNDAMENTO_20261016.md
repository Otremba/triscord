# Engenharia reversa com REA — aprofundamento de 16/10/2026

## Resultado desta rodada

Usado REA 6.4.0 pela CLI pública `C:/Users/camargo/Documents/GitHub/rea/scripts/rea.mjs`. Foram executados diagnóstico, projeção de análises existentes, três rastreamentos semânticos, rastreamento de feature, nova análise estática focal, geração de obrigações e exportação validada de evidências. Os resultados completos estão em `out/rea-deep-20261016/`.

A restrição do usuário de preservar a partida de Valorant continuou valendo: nenhuma janela aberta, captura de tela, entrada de teclado/mouse, attach a processo, microfone, câmera, build, pacote ou mudança no executável. As operações de análise focal foram executadas em prioridade Idle e afinidade de um processador lógico; o analisador novo recebeu heap máximo de 128 MiB e prazo de 5 s por fonte. O limite de heap não é limite de memória total da CLI.

Não houve busca de tokens/cookies, execução dos bundles, download de conteúdo do Discord nem instalação de motores/configurações. Dois revisores trabalharam em perguntas independentes somente com leitura de arquivos pequenos.

## Identidade e cobertura

Oito módulos extraídos foram reconferidos contra os bytes do bundle retido:

`out/discord-call-consumers-20261014/web.b19183c9af96925c.js`

SHA-256 do bundle: `6a1a62d7a599639f72be01a14d2ae49d36160a038519fe45c4ed8d5e45a134f8`.

Manifesto desta conferência: `out/rea-deep-20261016/verified-provenance.json`. Essa conferência foi feita por Node comum; ela não é apresentada como uma Evidence criada pelo REA.

| Módulo | Offset original | Bytes | Papel |
| --- | ---: | ---: | --- |
| 753070 | 5015491 | 2839 | Constantes/listas de qualidade |
| 742459 | 10683221 | 734 | Enumeração de fontes |
| 31728 | 689269 | 802 | Ações de PiP |
| 334463 | 9144116 | 2691 | Estado/persistência de PiP |
| 806931 | 3156647 | 863 | Tipos e mapas de largura |
| 475815 | 9829827 | 2176 | Abstração de fullscreen |
| 442353 | 8393097 | 539 | Preview de câmera, não seletor de tela |
| 471993 | 8391812 | 1284 | Entrada do seletor desktop/navegador |

O módulo 405916 foi revisado a partir do material existente, separadamente desses oito: offset 3198481, 4861 bytes, SHA-256 `ac21602eb0ece7a5412dd46a659166cc1aec6502fc9876eaac77308edd52c1db`.

Esses hashes vinculam os achados a assets retidos. A existência do Discord instalado como `app-1.0.9262` não comprova que seu runtime atual carregou esses assets. Não houve nova observação de runtime.

## Checklist das perguntas

| Pergunta | Situação | Conclusão e limite |
| --- | --- | --- |
| Os módulos extraídos ainda correspondem à origem? | Respondida no escopo | Oito módulos com fronteiras/hash conferidos. |
| Quais resoluções/FPS/presets existem? | Respondida estaticamente | 480/720/1080/1440/SOURCE; FPS internos 5/15/30/60; lista visual de FPS 15/30/60; presets VIDEO/DOCUMENTS/CUSTOM/AUTO e variantes mobile. Não prova disponibilidade universal. |
| DOCUMENTS sempre usa 30 FPS? | Parcial | Em 405916 a transição de mudança de resolução escolhe 30 quando o preset atual é DOCUMENTS. Não generalizar para todas as transições. |
| Como AUTO e VIDEO decidem qualidade? | Não resolvida | Os consumidores e funções importadas necessários não estão resolvidos neste escopo. |
| Quais ações de PiP estão no módulo? | Respondida estaticamente | OPEN/CLOSE/HIDE/SHOW/MOVE/RESIZE/UPDATE_RECT/UPDATE_SELECTED_WINDOW; corrigida atribuição documental errada. |
| O store demonstra popout nativo? | Não resolvida | Demonstra estado de PiP interno, não uma janela externa always-on-top. |
| Thumbnail 150×150 demonstra tamanho do cartão? | Respondida: não | É o tamanho solicitado ao backend de captura; geometria visual precisa de outra evidência. |
| Layout do seletor, aba Dispositivos e opções avançadas? | Não resolvida | Requer recuperar consumidores visuais ou observar a UI quando o usuário permitir. Não foi feita nova varredura de cache nesta rodada. |

## Observações estáticas relevantes à implementação

### Qualidade e presets

O módulo 753070 define SOURCE como zero e inclui 1440 na lista de resoluções. Em `src/screen_quality.h`, a configuração atual aceita 480/720/1080 e produz dimensões fixas 16:9. SOURCE precisa de representação própria e das dimensões reais da fonte; inserir somente um item no menu não entrega essa capacidade.

Mudanças manuais permitidas passam PRESET_CUSTOM a `setGoLiveSource` no módulo 405916. A API do Triscord representa altura/FPS, sem o estado de preset correspondente. `quality_policy.h` usa `textMode` e tetos de bitrate próprios; não há prova de que equivalham a DOCUMENTS ou AUTO. Valores de bitrate originais não foram estabelecidos.

O FPS 5 existe em enum/tabela interna, enquanto a lista visual recuperada contém 15/30/60. Não há motivo comprovado para adicionar 5 ao menu comum.

O código original consulta elegibilidade/capacidades para resoluções e FPS; as funções externas necessárias permanecem desconhecidas. O Triscord deve usar capacidades físicas reais da captura/encoder e suas políticas próprias, sem simular pagamento ou prometer equivalência a uma matriz não recuperada.

### PiP: errata e regras

O módulo 31728 exporta oito funções que despacham OPEN, CLOSE, HIDE, SHOW, MOVE, RESIZE, UPDATE_RECT e UPDATE_SELECTED_WINDOW. O `HANDOFF.md` antigo havia atribuído UPDATE_PROPS e ATTACH a ele; a atribuição foi corrigida com errata, sem modificar os assets.

O módulo 334463 persiste `openPosition` e `pipWidths`, com posição inicial BOTTOM_RIGHT. OPEN ignora um id já aberto; HIDE mantém a entrada; CLOSE a remove e escolhe outra do mesmo componente. MOVE aceita um dos ids selecionados e atualiza a posição de todas as entradas. RESIZE altera largura por tipo.

O módulo 806931 declara VIDEO=0 e CAMERA_PREVIEW=1, com mapa de larguras padrão 320/160. Os mapas 960/480 e 200/160 existem, mas seu papel como limites não está comprovado sem os consumidores.

Em `src/call_views.h/.cpp`, o escopo revisado contém CenterSurface e VoicePrejoinView. `main_window.cpp` conecta fullscreen a `CameraView::openPeer`, mas isso não demonstra a implementação de janela externa. Não foi feita uma busca que prove ausência de PiP no projeto inteiro.

### Captura e áudio

Módulo 742459 solicita tipos WINDOW/SCREEN, prefere APIs de preview conforme a capacidade e usa o backend desktop para os tipos restantes. A chamada nativa ficou sem receptor resolvido no rastreamento semântico. Não houve execução da captura.

No módulo 405916, o controle de áudio depende da fonte desktop, SOUNDSHARE e, para tela, `supportsScreenSoundshare()`. Troca de janela depende de capacidade, flags e seletor de sistema em Linux. Isso não estabelece o desenho das abas ou todos os estados de erro.

## Evidências REA novas e reutilizadas

| Arquivo em `out/rea-deep-20261016/` | Evidence ID | Resultado |
| --- | --- | --- |
| `quality-summary.json` | `ev_7191cafa665d7a67280ba531e9813a9940ca48525f3824b5c0ccef30efa3c320` | Projeção do parent de qualidade existente. |
| `quality-trace.json` | `ev_465ae34cd0e1baed364a22121749ab501d6934bce9cbe2ce80e4d037e1bab3b8` | PRESET_DOCUMENTS localizado; cobertura parcial, uma ambiguidade de escrita. |
| `enumeration-trace.json` | `ev_130a85a28fe7f809c3191c4b6b650e28e372bd850c7307defd8ab19c3b0e87a6` | getDesktopCaptureSources localizado; receptor/ponte não resolvidos. |
| `pip-trace.json` | `ev_107ac55482513831ccaa4b37a209325826fa66ada0d72f30e3527eb4da98b6d6` | Nenhuma seed literal retida correspondente, cobertura parcial. Não demonstra ausência da ação nos bytes. |
| `pip-feature.json` | `ev_34f7c708eeacdca266cc58b3f55a5212a17501be40593cc74ab130e292122caa` | Sem seed correspondente no grafo de aplicação existente. Não demonstra ausência no bundle. |
| `pip-actions-analysis.json` | `ev_3ecd9e61537ad2347271bd3c981e5fc19a2d051a38c542e2b22b27f2a4e7b9ac` | Nova análise do módulo 31728 em invólucro inerte com proveniência; 255 nós AST, sem erro de parsing. |
| `pip-focused-summary.json` | `ev_fbbca6b36d6c3d05022515fb0e858bd4239163bacebc95fb908e1d98f1ffb5ea` | Aplicação completa somente nesse alvo focal; 51 desconhecidos semânticos. |
| `ledger-focused.json` | `ev_78f3a257d61e406c1565cc1246427f68866dc942a319c1840eb5902d3105f81a` | Duas obrigações de PiP, ambas abertas. |
| `ledger-all.json` | `ev_9219921fcc65e1b7e01165548f0156bbd686c0c55deaa3df2bbca217b93b362b` | Treze obrigações: cinco revisadas e oito candidatas automáticas. Nenhuma encerrada. |

Parents reutilizados: qualidade `ev_ef613abf977e0cbfc985c2dc37c193f0dcb482e9643cd2ccdc802115e62dfa48`, ações PiP `ev_4665971939a4d6ea08572d39cf9660b61849052b8e6945c32313141706b8507d`, enumeração `ev_a8fb5d0e217d9710468c10a6946b5dfca1abd062079ce0777906d543ad3a9814`.

Exportação `evidence-bundle.json`: **11 registros, 4.811.966 bytes**, validada pelo comando REA `evidence-export`; `export-result.json` registra o resultado. O ledger amplo é uma saída separada, ligada aos parents. O conjunto exportado não equivale a uma exportação de toda a história do projeto.

## Registro de obrigações e próximos passos

O ledger amplo retornou `open`: 12 itens sem vínculo de implementação/verificador e um bloqueado pela observação visual adiada. Isso significa que não fornecemos ao ledger os vínculos/testes de paridade exigidos; não significa que 13 recursos inteiros do Triscord não funcionem.

Próximos passos concretos:

1. Resolver consumidores de AUTO/VIDEO e dimensão SOURCE a partir de módulos autenticados; manter disponibilidade condicionada à captura/encoder reais.
2. Recuperar o componente visual do seletor 266536 ou uma observação real dele. A lacuna de recuperação anterior continua sem resolução nesta rodada.
3. Tratar PiP interno e janela externa como perguntas separadas, com testes de transição e persistência correspondentes.
4. Depois da partida, observar os estados ainda desconhecidos no Discord e comparar com o Triscord no mesmo DPI/geometria. Sem enviar mensagens nem entrar em chamadas de terceiros para produzir evidência.
5. Vincular cada obrigação a um dono, casos originais, fixture e verificador da autoridade correta. Testes unitários isolados não fecham obrigações visuais/runtime.

## Limitações operacionais e tentativas preservadas

O diagnóstico mostrou configuração antiga do MCP no Codex e motores Hopper/Ghidra indisponíveis. Nada disso impediu análise JavaScript pela CLI; não foi alterada configuração nem instalado motor. Não há base para afirmar uso de todas as capacidades do REA ou engenharia reversa 100% concluída.

A primeira tentativa do ledger amplo recebeu registros/manifests em ordem não canônica e falhou. Seu erro permanece em `ledger.json`. O input foi corrigido para a ordem canônica, e `ledger-canonical-input.json` produziu `ledger-all.json`. O primeiro limite de heap 96 MiB também foi recusado porque o mínimo aceito é 128; a análise focal foi executada somente após ajustar esse parâmetro. A saída dessa recusa de parâmetro foi substituída pela análise bem-sucedida; a recusa continua registrada no histórico da conversa e aqui. Nenhum erro foi usado como evidência positiva.

Nenhum fonte de produção do Triscord foi alterado nesta rodada de REA. As otimizações de memória da rodada anterior continuam aguardando compilação/testes após o jogo, conforme `VALIDACAO_PENDENTE_JOGO.md`.
