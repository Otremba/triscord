# Fidelidade da transmissão — evidências de 18/10/2026

## Escopo e limites

Análise estática de JavaScript/CSS preservados e das imagens fornecidas pelo usuário; nenhuma interação nova com o Discord ou chamada real. O código foi lido como texto, sem executar os bundles. As capturas históricas em `out/claude-observations/SHARE.md` são evidência anterior, não nova observação ao vivo.

O resultado REA novo do agente principal está em `out/rea-fidelity-assets-analysis-20261018.json`, evidência `ev_039388afb32a75a45e0719eee7581051be888ab2f6961741056953f35ce502a1`, para `out/rea-claude-20261016/assets`. As descobertas abaixo têm seus próprios arquivos/hash e não são atribuídas a essa evidência quando o arquivo não pertence àquela árvore. As fontes CSS recuperadas têm proveniência no manifesto `out/discord-styles-recovered-20261014/manifest.json` (URL pública, posição no cache e hashes). Os bundles JS citados estão em `out/discord-call-sound-evidence/public-assets/`.

## Resultado aplicável

O indicador compacto usa **gg sans, 12 px, peso 700, espaçamento 0,02 em (0,24 px), altura de linha 16 px**, caixa de 16 px de altura, padding horizontal **6 px**. A qualidade e o selo vermelho são dois elementos adjacentes em um contêiner flex sem espaço. Qualidade arredondada somente à esquerda; vermelho arredondado somente à direita quando a qualidade está visível. Sem qualidade, vermelho arredondado nos quatro cantos.

`--custom-live-indicator-border-radius` é **16 px**; na caixa de 16 px isso produz extremidades semicirculares, com raio efetivo máximo de 8 px. Não usar o antigo raio arbitrário de 4 px. Cinza `PRIMARY_500` = `hsl(228 6.024% 32.549%)`, aproximadamente **#4e5058**. Vermelho `BADGE_NOTIFICATION_BACKGROUND` → `red-new-50` = `hsl(355.636 64.706% 50%)`, aproximadamente **#d22d39**. Valores pressupõem saturação padrão.

A variante LARGE sobrescreve tamanho/altura de linha para **14 px/15 px**. A variante compacta SMALL preserva os 12 px da tipografia `eyebrow`. O experimento `mana-type-consolidation` pode selecionar outra variante; não há prova de que esteja ativo na captura do usuário. Não aplicar seus valores como padrão.

## Encadeamento de componentes

1. `851cba1e9fca1bf0.js`, módulo **872363**, linha 1, coluna 747, byte UTF-8 746: exporta o indicador composto de transmissão. `Y` produz a qualidade com `shape: ROUND_LEFT`; `W` produz o selo LIVE com `shape: E ? ROUND_RIGHT : ROUND`. O contêiner tem classe `streamQualityIndicator__30845`, display flex e nenhuma propriedade gap. Quando a qualidade está visível, a animação do vermelho usa `borderRadius: 0px jpx jpx 0px`.
2. `web.b19183c9af96925c.js`, módulo **286134**, linha 125, coluna 129110, byte 5037545: converte SMALL/LARGE e formas para as classes de `857722`, delegando ao TextBadge de **812993**.
3. Mesmo bundle, módulo **812993**, linha 151, coluna 292603, byte 9951729: `TextBadge` (export `Lp`) chama o componente tipográfico com `variant: useBadgeTextVariant()`, classe `textBadge__463b7 base__463b7`, cor de fundo e forma.
4. Mesmo bundle, módulo **85463**, linha 158, coluna 28916, byte 10557737: seleciona `eyebrow` por padrão; somente o experimento escolhe `experimental/body-xs/semibold`.
5. `110425.65fcdb26ae18daf3.js`, módulo **857722**, linha 1, coluna 139, byte 138: associa classes `badge__52929`, `large__52929`, `round__52929`, `roundLeft__52929`, `roundRight__52929`.
6. `880248.8b2458ee83ec9f0b.js`, módulo **306091**, linha 1, coluna 96, byte 95: associa as classes base/textBadge usadas em 812993.

Posições de linha/coluna são baseadas em 1; offsets de bytes são baseados em 0. Os arquivos são minificados e contêm outras funções após os módulos citados.

## Trechos CSS exatos

`880248.d7ddb84cffd9bc71.css`, linha 1, coluna 6832 (byte 6831) para `eyebrow`:

```css
.eyebrow__463b7{font-family:var(--font-primary);font-size:12px;font-weight:700;letter-spacing:.02em;line-height:1.3333333333333333;text-transform:uppercase}
.base__463b7{box-sizing:border-box;color:var(--white);flex:0 0 auto;height:16px;min-height:16px;min-width:16px;text-align:center;text-transform:uppercase}
.textBadge__463b7{border-radius:var(--radius-sm);overflow:hidden;padding:0 6px;text-overflow:ellipsis;white-space:nowrap}
```

`110425.b57aec8326322648.css`, linha 2, coluna 1 (byte 384):

```css
.badge__52929{align-items:center;display:flex;justify-content:center}
.large__52929{font-size:14px;line-height:15px}
.round__52929{border-radius:var(--custom-live-indicator-border-radius)}
.roundLeft__52929{border-radius:var(--custom-live-indicator-border-radius) 0 0 var(--custom-live-indicator-border-radius)}
.roundRight__52929{border-radius:0 var(--custom-live-indicator-border-radius) var(--custom-live-indicator-border-radius) 0}
```

`102137.3323533077a9d55c.css`, linha 2, coluna 1 (byte 309):

```css
.qualityIndicator__30845{align-items:center;display:flex;text-transform:none}
.qualityIndicatorSmall__30845{text-transform:uppercase}
.qualityResolution__30845{margin-inline-end:4px}
.streamQualityIndicator__30845{align-items:center;display:flex;overflow:hidden}
```

`419070.5a76dee70a3767eb.css`, linha 2, coluna 4059 (byte 4242): `--custom-live-indicator-border-radius:16px`.

`952007.3b490a4a037fd35b.css`, linha 1, coluna 715980 (byte 715979), contém `--primary-500-hsl:228 calc(var(--saturation-factor, 1)*6.024%) 32.549%`; o mesmo arquivo contém `--badge-notification-background:var(--red-new-50)` e `--red-new-50-hsl:355.636 calc(var(--saturation-factor, 1)*64.706%) 50%`.

## Divergências encontradas no Triscord antes da correção

- `web/src/components/VideoTile.tsx`: barra persistente com “Tela de…”, perfil e ícones. `web/src/styles/call-view-controls.css`: reserva 40 px sob o vídeo. A referência mostra legenda sobre o vídeo; essa faixa não pertence ao cartão observado.
- `src/video_overlays.cpp`: selo em 11 px, padding 7 px, intervalo 6 px, raio 4 px e cinza #4f505a. A legenda desenha apenas texto, sem o ícone de tela junto do nome.
- O alvo `triscord-web` no CMake não registra as fontes locais no Qt: o navegador possui gg sans, mas isso não a disponibiliza ao QPainter. É necessário incluir/registrar o recurso de fontes também no host nativo.
- Valores de qualidade devem permanecer reais. 720P/30FPS versus 1080p/60FPS pode corresponder a configuração SD/HD e grade/cabeçalho de foco. O formato compacto é maiúsculo; a versão normal não força uppercase.

## Verificação indicada

Comparar rasterização nativa de selos com a referência, incluindo fonte efetivamente resolvida, dimensões, transparência, forma unida e texto. O teste de geometria DOM não valida o texto desenhado por Qt. Regressões: `run_web_stream_options_e2e.py`, `run_web_video_menu_e2e.py` (atualizar dependência da barra removida), chamada em grade, foco, pop-out, tela cheia e recortes de menus. Não afirmar fidelidade global apenas porque esses testes funcionais passaram.

## SHA-256

| Arquivo | SHA-256 |
|---|---|
| JS `851cba1e9fca1bf0.js` | `8e2ac08a782689ccf7c428c36cd1747a94619634859066b9b92093c72871d7e4` |
| JS `web.b19183c9af96925c.js` | `6a1a62d7a599639f72be01a14d2ae49d36160a038519fe45c4ed8d5e45a134f8` |
| JS `110425.65fcdb26ae18daf3.js` | `6a4ef5fc31b3ef60142e60a057e0a8f7e99c81c0872dd210e23aefdff1053a80` |
| JS `880248.8b2458ee83ec9f0b.js` | `f04afd0a329e123dce254252359b9c6b9adb7054e00b57cf75ca6ed3871ef7f5` |
| CSS `110425.b57aec8326322648.css` | `9396917add2d8aac1073d9b5d18768770962068738eaa447223e1e80da0830e9` |
| CSS `880248.d7ddb84cffd9bc71.css` | `cd6311ca9250a59a52028357b976056905c1358c2f28b86face7b17c044994b2` |
| CSS `102137.3323533077a9d55c.css` | `08ab29ea8225869d31079db701d7ea1dfacc55175a6b6dcbe3d89123896f5e79` |
| CSS `419070.5a76dee70a3767eb.css` | `7e4c21dfb9d35855be90e608a6e06464799b13325bcc87819219057a034c127b` |
| CSS `952007.3b490a4a037fd35b.css` | `cc0b5768c69332c1964fb2bf82329dad403ab63d5059cf33b99c86475912ea22` |
