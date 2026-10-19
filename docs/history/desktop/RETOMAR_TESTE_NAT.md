# Retomar: teste de NAT com VM Hyper-V (escrito em 15/10/2026)

## Por que isto existe
O item funcional nº 1 do projeto — chamada entre redes — nunca foi verificado. Tudo que está
validado é loopback nesta máquina. Esta é a tentativa de subir um degrau sem segunda rede.

## Estado no momento em que a sessão foi interrompida
- Hyper-V: **instalação preparada, reinício pendente** (`RebootPending: True`). Serviço `vmms` e
  módulo PowerShell do Hyper-V só existem depois de reiniciar.
- Disco livre em C:: 354 GB. Suficiente.
- ISO do Windows 11: **ainda não baixada**; o usuário ainda não autorizou o download.

## Entregas já concluídas e verificadas nesta sessão (sem commit, tudo na árvore de trabalho)
1. `src/ice_config.h/.cpp` + `tests/ice_config_tests.cpp`: servidores ICE deixaram de ser fixos no
   código. Resolução: env `TRISCORD_ICE_SERVERS` (JSON) → `QSettings` → 4 STUN públicos gratuitos.
   Aceita TURN com usuário/senha **sem recompilar**.
2. Paleta trocada de amostrada para **declarada**, extraída do bundle CSS real do Discord.
3. Tema unificado em `theme-midnight` (o preto AMOLED é um tema oficial do Discord, com valores
   declarados — não era invenção). Bordas passaram a usar os valores translúcidos reais.
Linha de base a manter: **UI 31/31, CTest 10/10, ~89 MB parado, 0 ms de CPU em 15 s, 17 threads.**

## Evidência nova (a melhor fonte que o projeto tem hoje)
`out/claude-observations/rea-css/`:
- `discord-bundle.css` — bundle CSS real do Discord, 778 KB, SHA-256 em `SHA256SUMS.txt`.
  Origem: cache do Chromium do cliente instalado (`%AppData%\discord\Cache\Cache_Data`, entrada
  `f_0000d2`, brotli). 4344 propriedades; 4 temas declarados.
- `TOKENS.md` — tabelas de tokens, diff contra o triscord, e dois adendos.
- `MOTION.md` — `--motion-spring-subtle`: mola de **598 ms** com 28 pontos de controle e overshoot
  de 2% em t=48,4%. **Não aplicada**: ainda não se sabe a quais elementos pertence.
- `midnight-fix-main-window.png` — captura do triscord após a troca de tema.
Resolvedor validado (`--brand-500` → `#5865f2`), no scratchpad da sessão: `rea/resolve.cjs`,
`rea/decode.cjs`. Se o scratchpad sumir, `decode.cjs` reconstrói tudo a partir do cache.

## Próximos passos, em ordem
1. **Reiniciar o Windows** e confirmar: `Get-Service vmms` deve existir.
2. Pedir ao usuário autorização para baixar a **ISO oficial do Windows 11** (~6 GB, sem cadastro e
   sem cartão — NÃO usar o Evaluation Center, que exige formulário).
3. Criar VM no switch "Default" (NAT embutido), instalar Windows **sem chave** (roda sem ativação).
4. Copiar `C:\Users\camargo\Desktop\triscord.exe` para dentro da VM.
5. Subir a sinalização e fazer host e VM entrarem na mesma sala. Registrar **quais tipos de
   candidato ICE** foram usados (host / srflx / relay) — é isso que diz se houve travessia real.
6. **Desligar o Cloudflare WARP durante o teste**, senão não se sabe se o medido é o NAT do usuário
   ou o túnel.

## Limite honesto deste teste, a declarar no relatório
Prova a mecânica: coleta de candidatos refletidos, pareamento e mídia atravessando um NAT real.
**Não** prova dois NATs independentes se furando — host e VM saem pelo mesmo IP público. CGNAT,
NAT simétrico do outro lado, latência, perda e upload reais continuam **não verificados** e exigem
uma segunda rede de verdade.

## Regras do usuário que continuam valendo
Gratuito, sem cartão, sem cadastro (se exigir, parar e perguntar). Não enviar mensagens nem entrar
em chamada com outras pessoas sem combinar. **Não fazer commit.** Cada entrega: build com
`scripts/build.ps1 -DevTools`, testes de UI e CTest passando, empacotar com `scripts/portable.ps1`,
atualizar `C:\Users\camargo\Desktop\triscord.exe`, e **medir consumo de novo**. Parado não pode
passar de ~120 MB nem usar CPU contínua. Separar sempre observado, inferido e desconhecido.

---

# ATUALIZAÇÃO 15/10/2026 ~22:15 — esta seção prevalece sobre o que está acima

## O plano mudou: Windows Sandbox, não ISO do Windows 11
Mesmo resultado para o teste de NAT (VM real com adaptador NAT), sem baixar 6 GB, sem instalar
Windows e sem chave de produto. O usuário havia autorizado a ISO; o Sandbox é o caminho mais barato
e igualmente gratuito. **Ignorar os passos 2–4 da lista acima.**

## Estado confirmado após o primeiro reinício
- Hyper-V **no ar**: `vmms` Running/Automatic, módulo PowerShell presente,
  switch `vEthernet (Default Switch)` (NAT) ativo.
- **Cloudflare WARP: Stopped** (desligado, autorizado pelo usuário). Conferir de novo antes de medir.
- Host: 31,9 GB RAM, 12 núcleos, virtualização ativa no firmware, 354 GB livres em C:.
- Pacote `Containers-DisposableClientVM` presente no sistema, mas **recurso ainda não habilitado**.

## Pendência exata onde a sessão parou
Rodar elevado o script `habilitar-sandbox.ps1` (está no scratchpad da sessão; se sumiu, recriar: ele
roda `Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All -NoRestart`
e `Add-LocalGroupMember -SID S-1-5-32-578 -Member <usuário>`), **e depois reiniciar**.

Na última tentativa o resultado ficou **indefinido**: `RebootPending: False`, grupo vazio e
`WindowsSandbox.exe` ausente, com um processo powershell de 22:09 ainda ativo. Não deu para
distinguir "ainda rodando" de "não rodou" sem elevação.

Caminho alternativo sem script: "Ativar ou desativar recursos do Windows" → marcar
**Área Restrita do Windows**.

Verificar se deu certo:
- `Test-Path C:\Windows\System32\WindowsSandbox.exe` → deve dar `True`
- `Get-LocalGroupMember -SID 'S-1-5-32-578'` → deve listar o usuário

## Passos seguintes depois que o Sandbox existir
1. Escrever um `.wsb` com pasta compartilhada (read-only) apontando para a pasta do `triscord.exe`.
2. Abrir o Sandbox e rodar o `triscord.exe` de dentro dele.
3. Subir a sinalização e fazer host e Sandbox entrarem na mesma sala.
4. **Registrar quais tipos de candidato ICE foram usados (`host` / `srflx` / `relay`).**
   Sem esse registro o teste não prova nada: os dois lados podem ter se achado por atalho local.

## Limite honesto (repetido porque é o que mais se esquece)
Prova a mecânica de travessia através de um NAT real. **Não** prova dois NATs independentes se
furando — host e Sandbox saem pelo mesmo IP público. CGNAT, NAT simétrico do outro lado, latência,
perda e upload reais continuam **não verificados** e exigem uma segunda rede de verdade.
