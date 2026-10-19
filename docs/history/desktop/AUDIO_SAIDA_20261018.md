# Correção da saída física dos efeitos — 18/10/2026

## Falha reproduzida

O usuário relatou ausência de som após a entrega anterior. O processo real estava sem variáveis de teste, com volume dos efeitos em 82%, saída padrão MCHOSE V9 PRO e sessão/dispositivo sem mute no mixer do Windows.

O teste com o mesmo `SoundPlayer` reproduziu a falha no hardware: o FFmpeg de Qt rejeitava o layout de canais da saída (`Output channel layout "" is invalid or unsupported`), seguido de `Context has not been initialized`. O pico da sessão no Windows permaneceu em zero. A decodificação isolada dos testes anteriores não exercitava essa conversão para o dispositivo físico.

## Correção

`SoundPlayer` usa `QAudioBufferOutput` com PCM estéreo explícito, 48 kHz/float, e envia os buffers a `QAudioSink` no dispositivo selecionado. Isso evita que o FFmpeg derive um layout vazio da descrição do headset. A fila tem limite de 4 MiB, escrita periódica e drenagem ao terminar o arquivo. Saída, volume imediato, interrupção da prévia, deafen e avisos separados são preservados. Falha ao abrir/escrever no dispositivo é informada ao painel.

O ajuste fica no reprodutor de efeitos; a configuração global do backend multimídia não foi alterada.

## Evidências desta rodada

- Novo alvo apenas de desenvolvimento `triscord-sound-output-smoke`: inspeciona a sessão de áudio do PID solicitado e mede a sessão do próprio teste via Core Audio. Não grava áudio, não lê microfone e não altera o mixer.
- Mesmo MP3, mesma saída: pico zero antes; pico 0,453916 depois da correção. O usuário confirmou na conversa que ouviu a risada.
- Quatro avisos na saída física: join/leave 0,079168; mute/unmute 0,079183. Todos decodificaram e produziram sinal na sessão do Windows.
- E2E com dois clientes e Workers locais reais: 18/18 verificações passaram novamente, incluindo transmissão nos dois sentidos, prévia isolada, avisos sem cortar o soundboard, deafen e erros.
- Logs: `out/audio-output-hardware.log` (falha original), `out/audio-output-fixed.log`, `out/audio-output-cues.log` e `out/audio-output-soundboard-e2e.log`.

A medição comprova sinal na sessão de saída e a confirmação do usuário comprova que ele ouviu o trecho. Voz de outros participantes não foi validada nesta rodada: o usuário informou que ainda não a havia testado.

## Entrega

Release 21/21 e portátil extraído 23/23. Desktop atualizado em `C:\Users\camargo\Desktop\triscord.exe`, pacote `00444f796a7ee30162e2`, SHA-256 `E2F881B293D2BA6EDAE9FF317C1315B9F8F979D8892E690D0948ED81C824D414`. Backup anterior em `out/desktop-backups/triscord-web-FF3A5E65.exe`. Nenhuma sessão real foi encerrada; a instância aberta precisa ser reaberta para usar o código novo. Sem commit ou deploy.
