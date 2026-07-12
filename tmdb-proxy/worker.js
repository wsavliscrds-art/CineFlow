/**
 * CINE — Proxy TMDB (Cloudflare Worker)
 *
 * O que ele resolve: sem proxy, a chave da TMDB vive no bundle do navegador.
 * Qualquer pessoa abre o DevTools, copia a chave e usa a sua cota.
 * Aqui o token fica no servidor; o app só conhece a URL do Worker.
 *
 * Ganhos de brinde:
 *   · cache de borda (a TMDB muda pouco — 5min de cache derruba a latência a ~20ms)
 *   · allowlist de rotas (o Worker não é um proxy aberto para a internet)
 *   · allowlist de origens (só o seu domínio pode chamar)
 *   · ponto único para trocar de provedor de dados sem republicar o app
 */

const TMDB_BASE = 'https://api.themoviedb.org/3';

/** Só estas rotas passam. Um proxy sem allowlist vira proxy aberto de terceiros. */
const ALLOWED = [
  /^\/configuration$/,
  /^\/trending\/(all|movie|tv)\/(day|week)$/,
  /^\/(movie|tv)\/(popular|top_rated|now_playing|upcoming|on_the_air|airing_today)$/,
  /^\/discover\/(movie|tv)$/,
  /^\/genre\/(movie|tv)\/list$/,
  /^\/search\/(multi|movie|tv)$/,
  /^\/(movie|tv)\/\d+$/,
  /^\/tv\/\d+\/season\/\d+$/,
];

/** Em produção, troque por ['https://seu-dominio.com'] e nada mais. */
const ORIGINS = ['*'];

/** Parâmetros que o cliente pode mandar. O resto é descartado — inclusive api_key. */
const SAFE_PARAMS = new Set([
  'language', 'region', 'page', 'query', 'sort_by', 'with_genres',
  'primary_release_date.gte', 'primary_release_date.lte',
  'first_air_date.gte', 'first_air_date.lte',
  'vote_average.gte', 'vote_count.gte',
  'include_adult', 'include_video_language', 'append_to_response',
]);

const cors = (origin) => ({
  'Access-Control-Allow-Origin': ORIGINS.includes('*') ? '*' : (ORIGINS.includes(origin) ? origin : 'null'),
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
});

const json = (body, status, origin) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin) },
  });

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'GET') return json({ status_message: 'Método não permitido' }, 405, origin);

    if (!ORIGINS.includes('*') && origin && !ORIGINS.includes(origin)) {
      return json({ status_message: 'Origem não autorizada' }, 403, origin);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/configuration';

    if (!ALLOWED.some((re) => re.test(path))) {
      return json({ status_message: 'Rota não permitida' }, 403, origin);
    }

    // Monta a URL upstream só com parâmetros da allowlist.
    const upstream = new URL(TMDB_BASE + path);
    for (const [k, v] of url.searchParams) {
      if (SAFE_PARAMS.has(k)) upstream.searchParams.set(k, v);
    }
    if (!upstream.searchParams.has('language')) upstream.searchParams.set('language', 'pt-BR');
    upstream.searchParams.set('include_adult', 'false'); // não negociável pelo cliente

    // Cache de borda: chaveado pela URL upstream (sem token, sem headers do cliente).
    const cache = caches.default;
    const cacheKey = new Request(upstream.toString(), { method: 'GET' });

    let res = await cache.match(cacheKey);
    if (!res) {
      const t0 = Date.now();
      let up;
      try {
        up = await fetch(upstream.toString(), {
          headers: {
            Authorization: `Bearer ${env.TMDB_TOKEN}`, // ⬅️ o segredo entra aqui, no servidor
            Accept: 'application/json',
          },
        });
      } catch {
        return json({ status_message: 'Upstream indisponível' }, 502, origin);
      }

      if (!up.ok) {
        const body = await up.text().catch(() => '');
        return new Response(body || JSON.stringify({ status_message: 'Erro na TMDB' }), {
          status: up.status,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin) },
        });
      }

      // Gêneros e /configuration mudam raramente → cache longo.
      const long = /^\/(genre|configuration)/.test(path);
      const ttl = long ? 604800 : 300; // 7 dias vs 5 minutos

      res = new Response(up.body, up);
      res = new Response(res.body, {
        status: res.status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': `public, max-age=${ttl}, s-maxage=${ttl}`,
          'X-Upstream-Ms': String(Date.now() - t0),
        },
      });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }

    // Reanexa o CORS (a resposta cacheada não guarda o Origin do chamador).
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors(origin))) out.headers.set(k, v);
    return out;
  },
};
