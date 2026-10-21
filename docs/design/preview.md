# Prévia isolada da revisão 02

Estado: **candidata para avaliação**, não ativada por padrão, não publicada e não copiada para a instalação. O objetivo completo continua em andamento: a direção visual e a aparência real ainda precisam ser avaliadas.

## O que foi implementado

- `WorkspaceNav`: marca plana, seletor completo de servidores, atalhos limitados sem perder acesso aos demais, início e entrada para criar/aceitar convite. Opções de convite, exclusão e saída reutilizam os menus existentes.
- `WorkspaceHome`: início baseado nos servidores reais da sessão, contexto da chamada atual, perfil/configurações e orientação quando não há servidores. Não inventa amigos, atividade ou métricas de uso.
- Chamada e conversa na mesma coluna na prévia, com alternância do chat e controles de chamada visíveis. Foco de vídeo, capacidades do núcleo e fluxo de menus continuam nos componentes existentes.
- `StatePanel`: carregamento inicial, ausência de canal e ações pertinentes. Falha de voz permanece visível na chamada, com ação explícita de reconexão existente.
- Tokens semânticos candidatos, superfícies sólidas, cobre discreto, navegação por foco, entradas e controles de configurações na mesma paleta. Movimento reduzido retira transições/animações na prévia.
- Adaptação dos componentes de login, perfil, menus e demais superfícies por tokens; não se trata de validação visual final dessas telas.
- A renderização da tela inicial foi separada do componente que possui os hooks da sala. Ir para o início desmonta os hooks/listeners da sala corretamente, em vez de retornar antes deles na mesma função.
- O botão compartilhado preserva simultaneamente `class`, `className`, `type`, `form` e `disabled`; ações sem `type` usam `button`, evitando submit implícito.

## Isolamento

O frontend só define `data-design=next` quando a URL contém `?design=next`. Todas as regras da folha candidata são prefixadas por esse atributo, inclusive dentro de media queries. O modo padrão continua usando a interface existente.

Para uma execução **manual e deliberada** do binário de desenvolvimento, o núcleo reconhece `TRISCORD_DESIGN_PREVIEW=1` e acrescenta o parâmetro à URL interna. Isso não altera o identificador `app.triscord.rust-preview`, não importa configurações da instalação e não executa atualização. Não há ativação persistente no sistema.

Nenhum lançamento manual foi feito por esta tarefa. Abrir a interface em execução não faz parte da validação permitida atualmente.

Em uma renderização web sem bridge nativa, os dados continuam sendo os fixtures já existentes; isso não deve ser apresentado como uma chamada ou conta real.

## Verificação realizada

- TypeScript sem erros.
- Unidades Node do estado de voz, contrato IPC e contratos da navegação/botões. O teste novo inspeciona VNodes e executa handlers com uma bridge falsa, sem DOM ou navegador. Confere acesso a todos os servidores, navegação para início, estado vazio e semântica de formulário.
- Build da interface com Tailwind/esbuild. Corrigida a resolução do conteúdo do Tailwind para ser relativa à configuração, evitando classes ausentes quando o build parte da raiz do repositório.
- 104 testes unitários Rust e compilação Windows MSVC, sequenciais com `-j 2`.
- Inspeção por PostCSS da contenção dos seletores da prévia. Essa análise comprova o prefixo das regras, não a aparência, a disposição ou o contraste final em execução.
- `git diff --check` sem erros de whitespace.

O build script não executa mais o runner visual headless automaticamente. Edge/Playwright/UI automation são excluídos da validação nativa em cumprimento às instruções atuais.

O aviso já existente `corrupt .drectve` permanece no build script do host; a compilação MSVC concluiu. `runtimeVerified=false`: nenhum app, navegador, instalador, captura, microfone, alto-falante ou E2E foi executado.

## O que falta antes de concluir o objetivo

### Continuação de usabilidade

Controles de perfil na lista de membros agora são botões HTML nativos, com nome acessível. A seleção de canal também usa um botão nativo, separado das ações de chat/convite: Enter nessas ações não executa mais um handler de seleção no contêiner. Isso também permite ativação nativa por Espaço sem handlers de teclado concorrentes.

Tooltips passam a abrir por foco, preservar handlers dos filhos e referenciar seu conteúdo por `aria-describedby`; Escape dispensa o tooltip visível. O fechamento de tooltip/modal não espera a duração da animação quando o sistema pede movimento reduzido.

TypeScript, unidades Node existentes, build da interface, 104 unidades Rust e compilação MSVC passaram após essas alterações. Nenhuma navegação real por teclado foi automatizada ou observada: isso ainda depende de validação em execução permitida. A lista abaixo continua pendente.

1. Avaliação/refinamento do usuário sobre a direção integrada em grafite/cobre, apresentada em `main-screen-v2.svg`.
2. Ajustes decorrentes dessa avaliação antes da ativação geral.
3. Conferência visual permitida das telas reais, incluindo larguras menores, popouts, vídeo nativo, foco, menus sobre vídeo, estados de erro e formulários. Compilação/unidades não comprovam esses itens.
4. Retirar ou substituir a camada Aurora global somente quando a nova direção estiver estabelecida, evitando duas identidades concorrentes. A prévia ainda usa compatibilidade com os tokens dos componentes existentes; isso não representa o design system final consolidado.
5. Revisão de acessibilidade e regressões dos fluxos completos dentro das formas de validação autorizadas. Não afirmar que todas as funcionalidades ou o desempenho real foram comprovados.

Não houve push, release, deploy ou substituição do aplicativo instalado.
