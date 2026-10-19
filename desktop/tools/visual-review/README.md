# Comparação visual independente

Responsabilidade exclusiva do Codex durante o trabalho conjunto. Ferramenta local de desenvolvimento; não integra o executável nem exige serviço pago. O Antigravity mantém responsabilidade pelo aplicativo, testes Qt, compilação e pacote.

Gere o relatório a partir de um manifesto dentro do workspace:

```powershell
node desktop/tools/visual-review/build.mjs --manifest desktop/out/discord-comparison-manifest.json --out desktop/out/discord-comparison-report
node --test desktop/tools/visual-review/build.test.mjs
```

Abra `index.html` da pasta de saída. Imagens são incorporadas: não há upload, dependências remotas ou servidor necessário para visualizar. Para importação manual com SHA-256 via Web Crypto, use um navegador com suporte a contexto local seguro; reconstruir pelo manifesto também calcula os hashes.

Formato do manifesto:

```json
{
  "title": "Discord versus triscord",
  "pairs": [{
    "id": "voice-connected",
    "title": "Chamada conectada",
    "notes": "Mesmo tamanho, escala e estado; tema preto é a adaptação autorizada.",
    "reference": {
      "path": "desktop/out/reference/voice-connected.png",
      "origin": "observed-discord",
      "state": "voice-connected",
      "dpi": 96,
      "note": "Captura real do Discord; registrar versão/escala/fonte da observação."
    },
    "implementation": {
      "path": "desktop/out/native-navigation-call.png",
      "origin": "triscord-test-fixture",
      "state": "voice-connected",
      "dpi": 96,
      "note": "App real com participantes injetados; não comprova WAN."
    }
  }]
}
```

Omitir um dos lados mantém a pendência visível. Não declarar DPI/estado/origem sem observar; use null ou omita quando desconhecidos. Dimensões vêm do PNG, SHA-256 é calculado e pode ser conferido contra campo `sha256` opcional. Arquivos externos ou redirecionados para fora do workspace são rejeitados.

Lado a lado, sobreposição com opacidade, zoom uniforme e mapa de diferenças estão disponíveis. Sobreposição/diferença ficam bloqueadas quando as dimensões divergem. Escalas e estados desconhecidos continuam sinalizados; geometria idêntica não significa validação aprovada. A cor preta difere deliberadamente da referência: diferença de pixels é um diagnóstico, nunca nota de fidelidade. Interações, visibilidade por estado, rede e dispositivos físicos exigem verificações próprias.

Notas da revisão são exportadas para JSON junto com hashes/metadados, sem bytes das imagens. Os arquivos escolhidos manualmente permanecem em memória; exporte antes de fechar. Cada importação manual é marcada como origem/contexto não verificados. Não há persistência automática de capturas privadas no navegador.
