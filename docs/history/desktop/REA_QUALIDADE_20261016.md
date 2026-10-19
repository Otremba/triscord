# Política de qualidade: evidência estática adicional — 16/10/2026

Continuação de `REA_APROFUNDAMENTO_20261016.md`, após o encerramento do jogo. Nenhum código recuperado foi executado. Seis factories foram extraídas de bytes originais, validadas sintaticamente como ObjectMethod pelo Babel e analisadas pela CLI pública REA 6.4.0 em invólucro inerte. Isso não comprova o comportamento do Discord atualmente instalado.

## Proveniência e cobertura

Origem retida: `out/discord-call-consumers-20261014/web.b19183c9af96925c.js`, SHA-256 `6a1a62d7a599639f72be01a14d2ae49d36160a038519fe45c4ed8d5e45a134f8`.

Manifesto com offsets em bytes, comprimento e SHA-256 por factory: `out/rea-deep-20261016/quality-policy-focused/manifest.json`. Recuperação reproduzível: `out/rea-deep-20261016/recover-quality-policy.cjs`. Seleção limitada a seis IDs e 64 KiB por factory, sem módulos ausentes nesta seleção.

| Módulo | Offset | Bytes | Função observada |
| --- | ---: | ---: | --- |
| 405916 | 3198481 | 4861 | Menu e transições de qualidade |
| 753070 | 5015491 | 2839 | Constantes e tabela ordenada de opções |
| 327649 | 5021476 | 733 | Elegibilidade de qualidade |
| 248174 | 5022210 | 717 | Experimento condicional de limites |
| 375742 | 5022928 | 200 | Primeira resolução elegível na tabela |
| 929921 | 8874243 | 1055 | Defaults, persistência e atualização de estado |

Análise `quality-policy-analysis.json`: Evidence `ev_a3ecd19b9639406e156b4466d6456d27ed29387435b5d9406c60f5c04956079f`. Projeção `quality-policy-summary.json`: `ev_c5db2dcd0f8017ce5e25e5cb88ad8db3ba2567560860cf4eafbc4e925ef8aad8`. Ambos em `out/rea-deep-20261016/`.

REA registrou 6 módulos, 3.363 nós AST, 69 findings e zero erros de parsing. Cobertura de aplicação completa somente para esse alvo focal; cobertura semântica desconhecida, com **728 desconhecidos**. Parsing sem erro não fecha paridade nem dependências dinâmicas.

## Observações dos bytes

- **Defaults/persistência (929921):** PRESET_VIDEO, 720p, 30 fps e soundshareEnabled=true. Store `ApplicationStreamingSettingsStore`, chave persistida literal `ApplicationStreamingSettingStore`. Estado existente restaura resolução/fps; preset ausente assume VIDEO e áudio nulo/ausente assume true. Isso descreve inicialização, não as preferências da conta atual.
- **Atualização (929921):** MEDIA_ENGINE_SET_GO_LIVE_SOURCE altera preset/resolução/frameRate apenas quando context=STREAM e qualityOptions existe; esse handler não altera áudio. STREAM_UPDATE_SETTINGS altera os campos não nulos, incluindo áudio.
- **AUTO (327649):** retorna a flag allowAutoQuality do módulo importado 258585, com location="canStreamWithSettings". A flag é elegibilidade; o algoritmo de adaptação não aparece nessa factory.
- **Demais presets (327649):** percorrem a tabela ZV com preset compatível, resolução e fps exatos. Entradas sem restrições são aceitas. Para entradas limitadas, basta entitlement de qualidade do usuário **ou** tier de guild elegível. Os corpos dos validadores importados continuam fora do alvo.
- **Fallback (375742):** usa find na tabela ZV para o fps solicitado com PRESET_CUSTOM. É a primeira entrada elegível em ordem de tabela, não um cálculo do maior número. SOURCE=0 aparece antes de 1440/1080/720/480.
- **Limites experimentais (248174):** experimento de guild "2026-05-frontier-tuning". Default com maxBitrate/maxResolution/maxFPS nulos e maskReportedQuality=false. Quatro variações configuram 1080p30 a 3,5 ou 5 Mbps, com/sem máscara. A função retorna null para guild ausente, premiumTier diferente de NONE, teste de usuário 474090.ki positivo ou entitlement MID. Só devolve config com maxBitrate não nulo. **Esses valores não são um bitrate universal do Discord.**
- **Transição manual (405916):** mudanças usam PRESET_CUSTOM. Ao alterar resolução enquanto o preset atual é DOCUMENTS, o fps enviado é 30. Quando a configuração coincide com o limite experimental, a alteração de fps consulta o fallback acima.

## Implicações para Triscord e lacunas

O Triscord atual oferece 480/720/1080 e geometria 16:9 em `src/screen_quality.h`; não possui estado equivalente de presets. Os 3 Mbps de textMode e 4 Mbps de `src/quality_policy.h` são política própria, sem prova de equivalência a DOCUMENTS/AUTO.

Próximas perguntas de implementação: persistir modo e áudio explicitamente; definir transições de modo manual/documentos; investigar dimensões SOURCE, captura/encoder de 1440p e adaptação real antes de expor opções. Não há razão funcional para reproduzir bloqueios pagos de outro produto.

Continuam desconhecidos: corpos das dependências de experimento/entitlement, seleção efetiva para a conta atual, algoritmo AUTO, dimensão SOURCE, caminhos nativos do encoder e comportamento visual/runtime. Os seis módulos novos não encerram automaticamente as 13 obrigações do ledger anterior. A investigação de servidores/locale permanece com Claude.
