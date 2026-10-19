# Recursos do cliente nativo/web (Windows)

Execute a partir da raiz do checkout nativo, com o cliente e os assets já compilados:

```powershell
.toolchain/venv/Scripts/python.exe desktop/tests/e2e/run_web_resource_benchmark.py --exe desktop/out/build/triscord-web.exe
```

Requer as dependências dos E2E locais (Workers/Miniflare, Python do projeto), psutil e Pillow. O padrão são oito ciclos; `--cycles` aceita 3 a 10. Usa duas contas descartáveis, Workers reais locais/D1, áudio injetado silencioso e câmera sintética. Não usa contas, câmera ou microfone reais. Cada cliente tem suas configurações e dados WebView2 isolados; instâncias pessoais ficam fora da medição e da limpeza.

Alice mede repouso, oito entradas/chamadas, editor de perfil com avatar PNG e banner GIF animado, ocultar/mostrar vídeo, saída/recuperação, repouso posterior e minimizar/restaurar. Bob acompanha os eventos do estado nativo: temporizadores JavaScript de janelas minimizadas podem ser suspensos, portanto não são usados para confirmar sua entrada/câmera. A fonte sintética tem 640×360; a resolução recebida é registrada em cada ciclo e pode ser inferior.

A cada segundo o harness acompanha PID e horário de criação dos processos dos dois clientes, incluindo navegador, renderer, GPU e auxiliares WebView2. Árvores sobrepostas invalidam o resultado. A limpeza verifica a identidade dos processos próprios antes de encerrá-los. Workers e Python não entram nos números. Os arquivos temporários são apagados somente sob o diretório temporário e com prefixo verificado.

- Memória privada: bytes privados comprometidos do Windows somados na árvore.
- Working set: memória residente somada; páginas compartilhadas podem ser contadas mais de uma vez.
- CPU: diferenças de tempo de CPU, com um núcleo = 100%; também normalizada pelo número de processadores lógicos. Primeiro ponto é aquecimento.
- Estatísticas por etapa: média, mediana, p95 e pico. Sondeos de diagnóstico a cada cinco segundos acrescentam pequena carga.

Relatórios versionados por horário em `desktop/out/web-resource-report/` (ignorados pelo Git): `summary.json`, `samples.json`, `samples.csv` e logs sem tokens. Só `passed: true` valida uma rodada. É exigida confirmação de câmera no emissor, dois participantes e frames nativos desenhados em cada chamada. Rodadas incompletas ou com erro permanecem como evidência de diagnóstico e não devem ser citadas como benchmark válido.

Este ensaio não mede WAN, captura física, 1080p, qualidade de áudio, memória dedicada da GPU nem ausência de vazamentos em sessões longas. O resultado descreve esta carga e esta máquina.
