# CINE

Catálogo de filmes e séries sobre a API do TMDB. Front-end estático, sem build. O token da API vive num Cloudflare Worker, nunca no navegador.

**Demo:** _(preencher após o deploy)_

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
