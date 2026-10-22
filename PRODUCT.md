# Product

<!-- impeccable:product-schema 1 -->

## Platform

desktop

## Stack

React + TypeScript + Vite + Tailwind CSS + shadcn/ui + Lucide React + Motion (Framer Motion). O núcleo nativo é Rust/Tauri (fonte de verdade do estado via snapshot/delta); o frontend é uma camada de visão fina. Sem Zustand — o núcleo já é a fonte de verdade.

## Users

O próprio autor (camargo) e seus amigos, em chamadas de voz/vídeo e conversas enquanto jogam. Uso pessoal e privado, sem público externo.

## Product Purpose

Um "Discord próprio": aplicativo desktop leve e privado para conversar por voz e vídeo, trocar mensagens e compartilhar tela com um grupo pequeno e conhecido de amigos. O sucesso é uma experiência fluida, confiável e agradável de usar em chamadas e conversas do dia a dia.

## Positioning

Um cliente de voz/vídeo/chat auto-hospedado e privado, com mídia nativa por hardware (captura/H.264, DSP/Opus) e um SFU LiveKit próprio, em vez de depender de um serviço de terceiros. Leve e sob controle do usuário.

## Operating Context

- Chamadas de voz e vídeo entre amigos, frequentemente durante jogos (Valorant e outros).
- Compartilhamento de tela e de câmera.
- Chat por sala (canais de voz com chat, e canais de texto).
- Servidores/espaços com canais, convites e moderação simples (dono da sala).
- Soundboard e sons de chamada.
- Perfis de usuário (avatar, faixa, bio, status).
- Configurações de conta, notificações, voz/vídeo, aparência e Windows.

## Capabilities and Constraints

- Núcleo Rust/Tauri é a fonte de verdade; o frontend recebe snapshot/delta e envia comandos validados (`deny_unknown_fields`).
- Vídeo nativo (Path A): o núcleo desenha cada transmissão em janela nativa sobre o tile; o frontend reporta geometria/oclusão.
- Mídia: captura/H.264 por hardware, DSP/Opus, mixagem em C++/Rust; SFU LiveKit na VPS.
- Autenticação: Google OAuth/PKCE e login por nome/senha; sessão DPAPI.
- Sem rede do renderer (CSP restritivo); todo I/O é feito pelo núcleo.
- Terminologia: "servidores" (espaços), "canais" (voz/texto), "salas", "transmissão" (compartilhamento de tela), "visão ampliada" (foco de vídeo).
- Restrição de validação: sem E2E/abrir app/dispositivos durante o desenvolvimento (o usuário pode estar jogando); validação por typecheck + testes unitários + build.

## Brand Commitments

- Nome: Triscord.
- Identidade visual anterior (midnight/azul, "gg sans") é evidência e anti-referência, não restrição — o usuário liberou decisões próprias de design.
- O usuário pediu explicitamente: interface bonita, moderna, animações suaves, aparência profissional, fluidez a 120fps, sem parecer clone do Discord ou template genérico.

## Evidence on Hand

- `desktop/web/src/protocol.ts` — contrato IPC completo (tipos, comandos, mensagens).
- `desktop/web/src/fixtures.ts` — sessões determinísticas para desenvolvimento/testes.
- `desktop-rust/src-tauri/src/core.rs` — enum `Command` (fonte de verdade dos comandos).
- `desktop/assets/` — sons de chamada e soundboard, ícone do app.
- `AGENTS.md` — histórico e decisões de produto.

## Product Principles

1. Fluidez perceptível e consistente em chamadas, mensagens e navegação.
2. Privacidade e controle: tudo auto-hospedado, sem serviço de terceiros.
3. Clareza e usabilidade acima de decoração.
4. Identidade própria, reconhecível e autêntica (não um clone).
5. Feedback imediato e satisfatório (visual e sonoro), sem excesso.

## Accessibility & Inclusion

- Respeitar `prefers-reduced-motion`.
- Navegação por teclado e estados acessíveis (WCAG 2.1 AA) nos componentes interativos.