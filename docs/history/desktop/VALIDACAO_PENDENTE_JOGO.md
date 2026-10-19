# Alterações de mídia validadas após o jogo — 16/10/2026

## Resultado atual

Após o usuário encerrar Valorant, build DevTools concluído e CTest executado em série: **12/12 suites, 52/52 casos de UI e 12/12 casos de hub/mídia**, sem falhas (37,65 s no CTest). O teste de prévia agora observa pelo menos cinco mudanças de quadro no GIF de dois quadros, verificando repetição com CacheNone, e confere a cor no recorte de avatar/banner de uma imagem de 1×4096 pixels. Os testes de cache verificam descarte no orçamento e nova tentativa após resposta acima de 2 MiB.

Empacotamento release passou nas verificações de inicialização e rejeição dos comandos de desenvolvimento. `C:/Users/camargo/Desktop/triscord.exe` atualizado e conferido com o pacote gerado: SHA-256 `000358CFF5C8307659A39F03B647E82F7BADCEF2AC96DC0A08CD570C87F9D959`. Não houve nova medição de RSS/CPU: orçamento de cache não significa limite da memória total do processo.

O registro abaixo preserva o que havia sido preparado durante a partida; suas referências a validação pendente foram superadas pelos resultados acima. Fluxos autenticados reais em produção e chamada física entre redes permanecem pendentes.

## Registro histórico

Restrição humana nesta conversa: continuar o Triscord sem atrapalhar Valorant. Nesta rodada Codex fez apenas leituras/edições de arquivos e verificação textual. Não abriu janelas, não mudou foco, não executou captura, câmera, microfone, builds, testes gráficos ou empacotamento. Não alterou nem encerrou processos do jogo.

Claude já havia concluído upload/renderização de avatar e faixa, com a entrega anterior registrada em `LIMITES_E_ESTADO.md`. O executável da Área de Trabalho continua sendo o pacote já validado dessa entrega; esta revisão ainda não entrou nele.

## Código preparado nesta rodada, ainda sem compilação

- `src/profile_media.h`: cache de imagens remotas passou de um QHash sem limite para QCache com descarte LRU e orçamento de 8 MiB de bytes comprimidos (metadados/alocações têm custo adicional).
- `src/profile_media.cpp`: limite de 2 MiB por resposta aplicado durante o recebimento, inclusive sem Content-Length. Buffer de rede limitado a 64 KiB; resposta excedente é abortada e libera a posição pendente para nova tentativa. Antes, a checagem ocorria só depois de acumular a resposta completa.
- `src/profile_preview.cpp`: GIF usa CacheNone sobre QBuffer reposicionável, em vez de manter todos os quadros decodificados em RAM. A pintura recorta a origem diretamente no destino, sem criar um pixmap intermediário potencialmente enorme para imagens estreitas.
- `tests/hub_api_tests.cpp`: dois testes novos preparados para descarte por orçamento e rejeição/retentativa de download acima do limite.

`git diff --check` não reportou problemas nos caminhos rastreados. Isso não confirma compilação, animação ou consumo real; nenhum resultado anterior de teste valida estas mudanças novas.

## Verificação quando o usuário encerrar o jogo

1. Confirmar que Claude não está alterando estes arquivos nem fazendo build. As quatro alterações acima estão somente no checkout nativo compartilhado, sem commit.
2. Build DevTools, com apenas um job se ainda houver preocupação com recursos: `scripts/build.ps1` atualmente força quatro jobs, portanto usar o CMake existente com `--parallel 1` após a configuração apropriada.
3. Rodar primeiro `native-hub-api` (inclui os dois testes novos) e testes de prévia do perfil. Verificar que GIF ainda anima e pode repetir sem cache de todos os quadros; testar transparência/recorte de imagem estreita.
4. Executar CTest em série; depois empacotar, conferir e atualizar o executável somente se passar.
5. Medir memória/CPU do app parado e com o editor animado aberto. Orçamento do cache não é limite de memória total do app.

Continuam pendentes: fluxos autenticados reais em produção e teste físico de chamada entre redes; não podem ser substituídos pela inspeção estática desta rodada.
