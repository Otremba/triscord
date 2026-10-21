# Proposta de direção visual — revisão 01

Estado: **proposta para avaliação**, ainda não aplicada ao aplicativo. O objetivo completo continua ativo. A imagem contém dados ilustrativos; não comprova funcionamento de chamada, captura ou transmissão.

## Decisão a avaliar

Uma interface de comunicação com superfícies grafite sólidas, azul moderado e hierarquia tipográfica. A personalidade vem do acabamento, das proporções e dos estados consistentes. Glow, neon, partículas, gradientes decorativos, blur e animação permanente ficam de fora.

A proposta mostra uma tela completa em 1600 × 1040: navegação de servidores, canais, conversa, chamada com transmissão, controles de mídia e participantes. A exibição simultânea de chamada e conversa evita perder o contexto. O estado de conexão e o microfone silenciado usam texto e ícones, além de cor. A ação destrutiva fica separada das demais.

## Referências e escolhas

- [21st.dev — componentes de chat](https://21st.dev/community/components/explore/chat-magic): composição de mensagens, campo de envio e ações contextuais. Referência de organização; não foi importado um template de chat de IA.
- [Aceternity — sidebars](https://ui.aceternity.com/blocks/sidebars): agrupamento e hierarquia da navegação, mantendo seleção e contexto claros.
- [Magic UI — Dock](https://magicui.design/docs/components/dock): agrupamento compacto de ações com rótulos acessíveis. A ampliação dos itens no hover não faz parte desta proposta.
- [React Bits](https://reactbits.dev/): referência para transições pontuais. Não foi escolhida uma animação decorativa contínua para a tela principal.

Nenhuma dessas bibliotecas precisa ser instalada para a avaliação. A implementação deve preservar Preact/Tauri e os contratos existentes, aproveitando componentes que tenham utilidade demonstrável e licença compatível.

## Base visual candidata

| Papel | Cor |
| --- | --- |
| Fundo principal | `#1B1F25` |
| Navegação e participantes | `#20242B` |
| Superfície de chamada | `#232830` |
| Campo de mensagem | `#282E38` |
| Borda | `#30353E` |
| Texto principal | `#E8EAF0` |
| Texto secundário | `#A3AAB6` |
| Texto de apoio | `#8B93A1` |
| Seleção e destaque | `#93A9EF` |
| Ação primária | `#3B4C76` com texto `#EDF1FF` |
| Conectado / falando | `#8FC6A9` |
| Silenciado / desconectar | `#E7A0A8` |

Texto principal sobre fundo: contraste calculado 13,75:1. Texto secundário na navegação: 6,66:1. Ação primária: 7,51:1. Esses cálculos validam somente os pares de cor, não a acessibilidade integral da aplicação.

- Escala de espaçamento: 4, 8, 12, 16, 24 e 32 px.
- Cantos de 8 px nos controles e 12 px nos painéis.
- Tipografia do sistema nesta proposta, sem download ou dependência de fontes proprietárias.
- Ícones lineares com espessura consistente. A implementação deve reutilizar um conjunto único, com rótulos de acessibilidade e tooltips.
- Movimento candidato: 120–160 ms em hover/foco e mudanças de estado; respeitar `prefers-reduced-motion`. A imagem estática não valida movimento.

## Estados e preservação de comportamento

Na implementação, nenhuma ação pode passar a anunciar sucesso sem execução real. O redesign não altera permissões, endpoints, dispositivos, tokens ou lógica de mídia. Limitações existentes devem continuar explícitas.

| Situação | Apresentação esperada |
| --- | --- |
| Conectando | Texto “Conectando…” junto aos controles; impedir ações incompatíveis |
| Reconectando | Aviso persistente no contexto da chamada; não simular qualidade de conexão |
| Sem mensagens | Nome do canal, descrição curta e campo de envio disponível |
| Sem canais / servidor | Orientação e ação de criação/convite conforme as permissões reais |
| Erro ao enviar | Preservar o rascunho e oferecer tentar novamente |
| Erro na transmissão | Explicar a falha no card e oferecer recuperação suportada |
| Silenciado / sem áudio | Botões, texto e ícones inequívocos; estados independentes |
| Movimento reduzido | Retirar transições não essenciais e indicadores animados |

## Sequência de trabalho e evidência de conclusão

1. Apresentar `main-screen.svg` e sua imagem de revisão. **Concluído nesta etapa.**
2. Receber o refinamento do usuário e revisar a tela principal. **Pendente.**
3. Consolidar tokens e componentes aprovados e aplicar primeiro à tela principal, sem alterar os contratos de funcionalidades. **Pendente.**
4. Estender a direção aprovada a login, configurações, perfis, menus e modais, incluindo navegação por teclado, foco, estados vazios/erro e movimento reduzido. **Pendente.**
5. Verificar tipos, compilação, contratos e regressões unitárias pertinentes. A inspeção visual do aplicativo real continuará limitada pelas instruções de testes vigentes; não apresentar uma imagem de proposta como validação em execução. **Pendente.**

Nenhum aplicativo, navegador, instalador, microfone ou alto-falante foi aberto para produzir a proposta. Nenhum E2E, captura de tela ou alteração da instalação foi realizado. O SVG/PNG foi desenhado diretamente a partir do script.

## Reprodução

```powershell
./.toolchain/venv/Scripts/python.exe docs/design/proposal.py --output desktop/out/design-proposal
```

O script requer Pillow e fontes Segoe UI do Windows. O SVG é editável; o PNG fica na pasta de saída ignorada pelo Git. O script não faz acesso à rede, não executa a aplicação e não lê dados de contas.
