# CINE

Catálogo de filmes e séries sobre a API do TMDB. Front-end estático, sem build. O token da API vive num Cloudflare Worker, nunca no navegador.

**Demo:** [cine-flow-sable.vercel.app](https://cine-flow-sable.vercel.app)

---

## O que tem aqui

```
index.html            App inteiro: UI, camadas de dados, estado. Zero dependências.
tmdb-proxy/           Cloudflare Worker que injeta o token da TMDB e cacheia na borda.
docs/arquitetura.md   Documento de arquitetura + design system.
```

## Rodar local

```bash
npx serve .          # ou: python3 -m http.server 8000
```

Abra `http://localhost:3000` e cole sua chave da TMDB na tela de conexão. Para desenvolvimento, a chave direta funciona — ela fica no `localStorage`.

## Publicar

Dois deploys independentes. **O Worker vem primeiro**, porque o site vai apontar pra ele.

### 1. Worker (o proxy)

```bash
cd tmdb-proxy
npx wrangler login
npx wrangler secret put TMDB_TOKEN     # token de leitura v4 (começa com "eyJ")
npx wrangler deploy
```

Anote a URL: `https://tmdb-proxy.SEU-SUB.workers.dev`

### 2. Site (Cloudflare Pages)

No dashboard da Cloudflare → **Workers & Pages → Create → Pages → Connect to Git**, aponte pra este repositório:

| Campo | Valor |
|---|---|
| Framework preset | None |
| Build command | *(vazio)* |
| Build output directory | `/` |

Todo push na `main` republica sozinho.

> Alternativa: **GitHub Pages** (Settings → Pages → Deploy from branch → `main` / `root`). Funciona igual, é estático.

### 3. Fechar o CORS

Com o domínio do site em mãos, edite `tmdb-proxy/worker.js`:

```js
const ORIGINS = ['https://cine.pages.dev'];   // ← seu domínio, não '*'
```

E rode `npx wrangler deploy` de novo.

Com `'*'`, qualquer site do mundo pode consumir seu Worker e queimar sua cota da TMDB. Essa é a única linha que separa o app de teste do app publicado.

### 4. Ligar

Abra o site e, na tela de conexão, **cole a URL do Worker** em vez da chave. O app detecta que é uma URL e entra em modo proxy — nenhuma credencial sai do navegador.

---

## Conta de usuário e verificação por email

O app tem registro/login (nome, email e senha) via **Supabase Auth**. O fluxo:

1. **Criar conta** → o Supabase envia um link de verificação para o email.
2. O usuário clica no link → o email é confirmado e ele volta para o site já logado.
3. Sem confirmar, o login é bloqueado (o app reabre o painel "Confirme seu email", com reenvio).

A conta e a credencial do TMDB são independentes: primeiro entra na conta, depois conecta o TMDB.

**Configuração única no painel do Supabase** (Authentication → URL Configuration):

| Campo | Valor |
|---|---|
| Site URL | `https://cine-flow-sable.vercel.app` |

Sem isso, o link do email confirma a conta mas redireciona para `localhost:3000` (padrão do Supabase).

> O email de verificação usa o SMTP embutido do Supabase, que tem limite de ~2 emails/hora
> por projeto — suficiente para testar. Para produção de verdade, configure um SMTP próprio
> em Authentication → Emails.

---

## Segurança: o que é e o que não é

| | Chave direta | Proxy |
|---|---|---|
| Onde o token vive | `localStorage` do usuário | Secret do Worker |
| Quem pode ler | Qualquer um com DevTools | Ninguém |
| Uso | Dev local | Produção |

O app aceita os dois. A tela de conexão decide pelo formato do que você colar: começa com `http` → proxy; senão → chave.

---

## Roadmap

- [ ] Deep links (`#/movie/603`) — hoje o botão voltar do Android fecha o app em vez do modal
- [ ] PWA: manifest + service worker (instalar no celular, cache offline real)
- [ ] Página `/sobre` com a atribuição obrigatória do TMDB
- [ ] Migrar para React Native (a arquitetura em `docs/arquitetura.md` já está desenhada pra isso)

---

## Atribuição

Este produto usa a API do TMDB, mas não é endossado ou certificado pelo TMDB.
