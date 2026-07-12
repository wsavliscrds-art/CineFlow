# CINE

Catálogo de filmes e séries sobre a API do TMDB. Front-end estático, sem build, com conta de usuário (Supabase Auth), proxy autenticado no servidor e painel administrativo. O token da TMDB vive no Vault do Supabase — nunca no navegador, nunca no repositório.

**Demo:** [cine-flow-sable.vercel.app](https://cine-flow-sable.vercel.app) · **Painel admin:** [/admin](https://cine-flow-sable.vercel.app/admin)

---

## O que tem aqui

```
index.html                       App inteiro: UI, camadas de dados, estado. Zero dependências.
admin.html                       Painel administrativo (métricas, usuários, auditoria, MFA).
supabase/functions/tmdb-proxy/   Edge Function: proxy TMDB com allowlist, rate limit por
                                 usuário e bloqueio de contas. Token no Vault do Supabase.
tmdb-proxy/                      Alternativa: Cloudflare Worker com a mesma allowlist.
docs/arquitetura.md              Documento de arquitetura + design system.
```

## Como funciona

1. A pessoa **cria a conta** (nome, email, senha) e **confirma o email** pelo link.
2. Ao entrar, o app fala com a Edge Function `tmdb-proxy` autenticada com a própria sessão —
   ninguém precisa de chave da TMDB. A tela de conexão só aparece como fallback.
3. Buscas, aberturas de título e sessões geram eventos (tabela `events`, protegida por RLS)
   que alimentam o painel `/admin` — restrito a contas com papel `admin` no servidor.
4. O consumo da semana vira o **Top 10 da semana**: um popup semanal com o ranking real da
   plataforma (RPC `top_week()`, agregado anônimo; completa com o trending da TMDB enquanto
   a base é pequena). Depois de algumas escolhas, o app também sugere títulos parecidos em
   popup. No desktop, as esteiras ganham setas ← → e a navegação vira uma pílula flutuante.

## Rodar local

```bash
python3 -m http.server 8000    # ou: npx serve .
```

Abra `http://localhost:8000`, crie uma conta e use normalmente (o proxy integrado aceita
localhost nas origens). Sem internet ou sem Supabase, a tela de conexão aceita uma chave
TMDB direta — ela fica no `localStorage`.

## Backend (Supabase)

Já provisionado no projeto `cineflow` (região São Paulo). Para recriar do zero:

1. **Migrações**: o schema está no histórico de migrações do projeto (profiles, events,
   favorites, admin_audit, RPCs `admin_*`, RLS em todas as tabelas).
2. **Token da TMDB no Vault**: `select vault.create_secret('SEU_TOKEN_V4', 'TMDB_TOKEN');`
3. **Edge Function**: `supabase functions deploy tmdb-proxy` (verify_jwt ligado).
4. **Site URL** em Authentication → URL Configuration: o domínio do site (para o link
   de confirmação de email redirecionar certo).

O papel `admin` nasce automático para os emails do dono (trigger `handle_new_user`);
outros admins são promovidos pelo próprio painel.

---

## Conta de usuário e verificação por email

O app tem registro/login (nome, email e senha) via **Supabase Auth**. O fluxo:

1. **Criar conta** → o Supabase envia um link de verificação para o email.
2. O usuário clica no link → o email é confirmado e ele volta para o site já logado.
3. Sem confirmar, o login é bloqueado (o app reabre o painel "Confirme seu email", com reenvio).

**Configuração única no painel do Supabase** (Authentication → URL Configuration):

| Campo | Valor |
|---|---|
| Site URL | `https://cine-flow-sable.vercel.app` |

Sem isso, o link do email confirma a conta mas redireciona para `localhost:3000` (padrão do Supabase).

> O email de verificação usa o SMTP embutido do Supabase, que tem limite de ~2 emails/hora
> por projeto — suficiente para testar. Para produção de verdade, configure um SMTP próprio
> em Authentication → Emails.

---

## Painel administrativo (`/admin`)

Página separada, mesma conta Supabase — mas **só entra quem tem papel `admin`**, e a
checagem acontece no servidor (`is_admin()` dentro de cada RPC + RLS). O painel tem:

- **Visão geral em quase tempo real** (atualiza a cada 30s): usuários totais/ativos/online/
  bloqueados, buscas hoje/total, acessos.
- **Gráficos**: buscas por horário (Brasília), crescimento de usuários e de buscas (30 dias),
  dispositivos, tendências 24h/semana/mês, filmes e séries mais abertos, ranking por categoria.
- **Gestão de usuários**: buscar, bloquear/desbloquear (derruba o acesso na hora, inclusive no
  proxy), promover/rebaixar admin, renomear, excluir — tudo auditado em `admin_audit`.
- **Histórico de pesquisas** e **auditoria administrativa**, com exportação **CSV** e **PDF**
  (imprimir → salvar como PDF).
- **MFA (TOTP)**: cadastre um app autenticador; depois disso o painel exige o código a cada
  login (o `is_admin()` do servidor passa a exigir sessão aal2).
- **Sessão**: logout automático após 15 min de inatividade.

## Segurança

| Camada | O que garante |
|---|---|
| Token TMDB | Vault do Supabase; lido só pela Edge Function (service_role) |
| Proxy | Allowlist de rotas e parâmetros, rate limit por usuário (120/min), CORS restrito, exige login |
| Banco | RLS em todas as tabelas; usuário só lê/escreve o que é dele |
| Admin | RPCs `security definer` com `is_admin()` no servidor; MFA opcional; auditoria completa |
| Site | CSP, X-Frame-Options DENY, nosniff, Referrer-Policy (via `vercel.json`) |
| Front | Nenhum segredo no bundle; chave publishable do Supabase é pública por design |

**Nenhuma tela do app menciona token ou chave de API.** Se o catálogo cair, o usuário vê
"Catálogo indisponível" com um botão de tentar novamente — e só. Para desenvolvimento,
uma credencial própria pode ser injetada por baixo dos panos via console:
`kv.set('tmdb-key', 'sua-chave-ou-url')` e recarregue (fica no `localStorage`).

O fluxo "Esqueci minha senha" é todo dentro do app: o link do email abre a tela de nova
senha no próprio site.

---

## Roadmap

- [ ] Deep links (`#/movie/603`) — hoje o botão voltar do Android fecha o app em vez do modal
- [ ] PWA: manifest + service worker (instalar no celular, cache offline real)
- [ ] Página `/sobre` com a atribuição obrigatória do TMDB
- [ ] Notificações push (lançamentos da minha lista)
- [ ] Migrar para React Native (a arquitetura em `docs/arquitetura.md` já está desenhada pra isso)

---

## Atribuição

Este produto usa a API do TMDB, mas não é endossado ou certificado pelo TMDB.
