# Contexto do projeto — CINE

Catálogo de filmes e séries sobre a API do TMDB. Front-end estático (um único `index.html`, sem build, sem dependências) + um Cloudflare Worker que atua como proxy autenticado.

O documento de arquitetura completo está em `docs/arquitetura.md`. Ele descreve a versão React Native planejada; o `index.html` é a implementação web da mesma arquitetura, e as camadas têm os mesmos nomes de propósito.

## Camadas dentro do `index.html`

O `<script>` está dividido em blocos comentados, nesta ordem. Respeite a separação ao editar:

```
core/config      TMDB.BASE, tamanhos de imagem, BUFFER_PAGES
core/storage     adapter kv (localStorage com fallback pra memória)
core/errors      AppError + fábricas. Nenhum erro cru de fetch escapa da camada http.
core/http        request(): dedup, cache de memória, modo chave vs modo proxy
data/mapper      toTitle(): DTO snake_case da TMDB → entidade camelCase
data/repository  repo.page / discover / search / genres / details / season
domain/sorting   ⭐ ordenação A–Z client-side (ver abaixo)
core/auth        Supabase Auth: registro (nome+email+senha), login, verificação por email
presentation/*   store, components (Card, Rail, Seasons), screens, navegação, tela de conta
```

A conta de usuário (Supabase) e a credencial do TMDB são independentes: primeiro
a pessoa entra na conta (`#auth`), depois conecta o TMDB (`#gate`). A chave
publishable do Supabase no `index.html` é pública por design — não é segredo.

## Regras que não são negociáveis

**1. A camada de domínio não conhece a TMDB.**
Nada de `poster_path`, `snake_case` ou `media_type` fora de `data/mapper`. Se você precisar de um campo novo da API, adicione ao mapper — não vaze o DTO pra UI.

**2. A ordenação A–Z é client-side, e isso é proposital.**
`sort_by=original_title.asc` da TMDB ordena pelo título **original** (coreano, japonês…), não pelo traduzido. O usuário vê "Parasita" mas o item está ordenado por `기생충`. A solução implementada: buffer de até 10 páginas + `Intl.Collator('pt-BR')` com remoção de artigos iniciais. Não "simplifique" isso mandando o sort pro servidor.

**3. Erros são localizados.**
Cada esteira tem seu próprio tratamento de erro. Se "Séries no ar" cair, a Home continua funcionando. Não centralize num boundary global.

**4. Skeleton tem o mesmo layout do conteúdo real.**
Se as dimensões diferirem, o conteúdo "pula" ao carregar. Ao criar um componente novo, crie o skeleton junto.

**5. O Worker tem allowlist.**
`ALLOWED` (rotas) e `SAFE_PARAMS` (query params) em `tmdb-proxy/worker.js`. Rota nova no app → rota nova na allowlist, senão volta 403. Proxy sem allowlist é proxy aberto.

**6. Nenhum segredo no repositório.**
O `TMDB_TOKEN` é secret do Wrangler. Nunca no `wrangler.toml`, nunca no `index.html`.

## Design tokens

Todos em `:root` no `<style>`. Não escreva cor ou espaçamento literal no CSS — use as variáveis. Grid de 4pt (`--xs` a `--xxxl`).

## Como testar

Não há test runner. Antes de commitar:

```bash
npx serve .
```

Checklist manual: Home carrega as esteiras · scroll horizontal pagina · Explorar com A–Z ordena de verdade (checar acentos: "Órfã" perto de "O", não depois de "Z") · filtro sem resultado mostra empty state · detalhes de série mostram temporadas · modo offline (DevTools → Network → Offline) não trava a tela.
