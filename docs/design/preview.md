# Interface integrada — grafite e azul discreto

Em 21/10, o usuário aprovou **azul discreto** para a direção com navegação integrada. O frontend agora a usa por padrão, sem parâmetro de URL ou variável de ambiente. A interface está no build de desenvolvimento; não foi publicada nem copiada para a instalação.

## Implementação

- Navegação integrada com marca plana, seletor completo de servidores, atalhos recentes e acesso a criação/convites. A tela inicial usa os servidores reais, contexto da chamada e perfil/configurações, sem métricas inventadas.
- Chamada e conversa na mesma coluna, com alternância do chat e controles visíveis. Capacidades do núcleo e contratos de ações continuam existentes.
- `StatePanel` para carregamento, ausência de canal e ações pertinentes; falhas de voz persistem com reconexão explícita.
- `desktop/web/src/styles/workspace.css` consolida superfícies, tipografia, foco, controles e estados compartilhados de login, configurações, perfis, menus e modais. Aurora foi retirada do bundle.
- Botões sólidos preservam `class`, `className`, `type`, `form` e `disabled`. Ações usam `type=button` por padrão. Marca sem gradiente e cards sem iluminação/rastreamento do mouse. Personalização de arte/cores do perfil permanece.
- Botões nativos para membros e seleção de canal, ações de canal separadas, tooltips por foco/hover com `aria-describedby` e Escape. Movimento reduzido também remove espera no fechamento dos overlays. O aviso de tela cheia expira por temporizador mesmo com animações desativadas.

Paleta: canvas `#1E2021`, painel `#292C2D`, azul `#A4B8E6`, seleção `#303B51`, botão `#405780` e texto do botão `#F3F6FF`. Contrastes calculados para pares específicos: texto/botão 6,72:1, texto/hover 5,51:1, texto/seleção 8,93:1. Não representam auditoria de todas as telas.

A chave `TRISCORD_DESIGN_PREVIEW` foi retirada do núcleo, pois a direção aprovada é o padrão. O identificador e os dados separados `app.triscord.rust-preview` permanecem. Sem bridge nativa, a página continua usando os fixtures existentes; isso não representa conta/chamada real.

## Verificação

TypeScript, unidades Node de estado de voz/IPC/VNodes, build Tailwind/esbuild, 104 testes Rust sem interface e compilação Windows MSVC passaram. O build continua sequencial com `-j 2`. A análise estática da folha confirma a contenção dos seletores em `data-design=workspace`; não comprova geometria ou aparência em execução.

O aviso não fatal `corrupt .drectve` continua no build script do host. `runtimeVerified=false`: nenhum aplicativo, navegador, instalador, captura, dispositivo ou E2E foi executado. O aplicativo instalado e chamadas não foram interrompidos. Não houve push, release ou deploy.

## Limites restantes

A direção visual foi aprovada e aplicada ao código. Ainda falta conferir a aparência e interação das telas reais quando a validação visual for permitida, incluindo larguras menores, popouts, vídeo nativo, menus sobre vídeo, foco e estados de formulário. As imagens SVG/PNG anteriores são propostas estáticas; a revisão 02 registra a alternativa cobre, substituída pela escolha de azul. Não afirmar paridade funcional completa ou resolução dos problemas de mídia da reescrita por esta mudança visual.

## Continuação — orientação e envio de mensagens

O tipo do canal agora vem exclusivamente do campo `kind` do snapshot; nomes como “Geral” deixam de converter visualmente um canal de voz em canal de texto. A conversa permanece disponível antes de entrar na voz, junto a um painel compacto de participantes e entrada explícita. O botão da lista de membros anuncia seu estado expandido.

O compositor ganhou ação de envio visível, aviso de envio em andamento e erro acessível com nova tentativa. Um pedido pendente bloqueia submits duplicados. Em falha do comando IPC, o rascunho permanece; uma resposta de sucesso não limpa texto editado durante o pedido. Trocas de servidor/canal remontam o painel por identidade, descartando feedback de outra sala. O temporizador de limite de mensagens é cancelado no unmount. A aceitação do comando pelo núcleo não é comprovante de entrega ao servidor; o protocolo atual não oferece confirmação individual de entrega.

TypeScript, unidades Node existentes, 104 unidades Rust, build frontend e compilação MSVC passaram após essa continuação. Não foram exercitados envio real, teclado, layout ou dispositivos. runtimeVerified=false. Conferência visual permanece pendente.
