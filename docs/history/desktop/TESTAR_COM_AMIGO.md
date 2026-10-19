# Testar a prévia com um amigo

Use a branch `rewrite/native-desktop` e o executável Windows 0.6.2. Essa versão ainda
é experimental; o cliente Electron estável usa outra cadeia de mídia.

1. Envie ao amigo somente `desktop/out/Triscord.exe`. Ambos devem abrir esse
   arquivo; ele prepara as bibliotecas automaticamente no primeiro uso.
2. Informe seu nome, clique **Conectar** e entrem na mesma sala, por exemplo
   **Geral**. O servidor e o acesso ao grupo já estão configurados nesse pacote.
   Não há campo de API, código privado ou extração manual de ZIP.
3. Escolham os dispositivos de áudio e cliquem **Ativar microfone**. Usem fones
   no primeiro teste. Confiram voz nos dois sentidos e mute/deafen.
4. Selecione uma janela ou monitor e clique **Compartilhar tela**. O amigo deve
   selecionar a transmissão recebida. Testem tela cheia, zoom e **Parar**.
5. Troquem mensagens e usem o botão direito para reagir. O dono pode trancar e
   limitar a sala, e usar o botão direito sobre alguém para expulsar ou silenciar.
6. Desconectem um cliente, conectem novamente e confiram chat, voz e tela.

Quem receber esse executável também recebe acesso ao grupo; distribua somente
entre seus amigos. A versão genérica compilada sem convite continua configurável,
mas não é o pacote descrito neste roteiro.

Compartilhamento usa H.264 por hardware e requer GPU/driver compatível com a
captura e codificação do Windows. O padrão atual é 720p30/2,5 Mbps por destino.
O áudio do sistema ainda não acompanha a tela. Webcam, soundboard, atalhos
globais e outras funcionalidades mantidas continuam em implementação.

O servidor Free controla salas e sinalização; voz/tela seguem diretamente entre
os PCs. Sem TURN configurado, redes restritivas podem deixar salas/chat funcionando
enquanto a mídia não conecta. Registre apenas o comportamento percebido e as
mensagens simples do aplicativo; não existe painel de diagnóstico permanente.
Um teste sintético no mesmo PC não comprova latência nem travessia de NAT entre
duas redes. A comparação de consumo/qualidade com o Electron também está pendente.
