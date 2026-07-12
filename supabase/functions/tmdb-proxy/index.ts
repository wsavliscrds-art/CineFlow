/**
 * CINE — Proxy TMDB (Supabase Edge Function)
 *
 * Mesmo papel do Cloudflare Worker em tmdb-proxy/worker.js, mas integrado à
 * conta: exige usuário logado (verify_jwt no gateway), aplica rate limit por
 * usuário e recusa contas bloqueadas. O token da TMDB vive no Vault do
 * Supabase e só é lido aqui, no servidor — nunca chega ao navegador.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';

const TMDB_BASE = 'https://api.themoviedb.org/3';

/** Só estas rotas passam. Proxy sem allowlist é proxy aberto. */
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

/** Origens autorizadas a consumir o proxy. */
const ORIGINS = [
  'https://cine-flow-sable.vercel.app',
  'http://localhost:8000',
  'http://localhost:3000',
];

/** Parâmetros que o cliente pode mandar. O resto é descartado. */
const SAFE_PARAMS = new Set([
  'language', 'region', 'page', 'query', 'sort_by', 'with_genres',
  'primary_release_date.gte', 'primary_release_date.lte',
  'first_air_date.gte', 'first_air_date.lte',
  'vote_average.gte', 'vote_count.gte',
  'include_adult', 'include_video_language', 'append_to_response',
]);

const RATE_LIMIT = 120;           // requisições por usuário…
const RATE_WINDOW_MS = 60_000;    // …por minuto

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

let tmdbToken: string | null = null;
async function getToken(): Promise<string> {
  if (!tmdbToken) {
    const { data, error } = await admin.rpc('get_tmdb_token');
    if (error || !data) throw new Error('TMDB_TOKEN ausente no Vault');
    tmdbToken = data as string;
  }
  return tmdbToken;
}

const rate = new Map<string, { n: number; t: number }>();
const blockedCache = new Map<string, { blocked: boolean; t: number }>();

function corsHeaders(origin: string) {
  const allowed = !origin || ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? (origin || '*') : 'null',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

const json = (body: unknown, status: number, origin: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
  });

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin') ?? '';
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== 'GET') return json({ status_message: 'Método não permitido' }, 405, origin);
  if (origin && !ORIGINS.includes(origin)) return json({ status_message: 'Origem não autorizada' }, 403, origin);

  // O gateway já validou o JWT; aqui só extraímos o usuário para limites.
  let userId = 'anon';
  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    userId = JSON.parse(atob(jwt.split('.')[1] ?? '')).sub ?? 'anon';
  } catch { /* segue como anon — o gateway é quem barra token inválido */ }

  // Conta bloqueada não consome API (cache de 60s para não pesar o banco).
  const cached = blockedCache.get(userId);
  if (!cached || Date.now() - cached.t > 60_000) {
    const { data } = await admin.from('profiles').select('blocked').eq('id', userId).maybeSingle();
    blockedCache.set(userId, { blocked: !!data?.blocked, t: Date.now() });
  }
  if (blockedCache.get(userId)?.blocked) {
    return json({ status_message: 'Conta bloqueada' }, 403, origin);
  }

  // Rate limit por usuário.
  const r = rate.get(userId);
  if (!r || Date.now() - r.t > RATE_WINDOW_MS) rate.set(userId, { n: 1, t: Date.now() });
  else if (++r.n > RATE_LIMIT) return json({ status_message: 'Muitas requisições' }, 429, origin);

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/tmdb-proxy/, '').replace(/\/+$/, '') || '/configuration';
  if (!ALLOWED.some((re) => re.test(path))) {
    return json({ status_message: 'Rota não permitida' }, 403, origin);
  }

  const upstream = new URL(TMDB_BASE + path);
  for (const [k, v] of url.searchParams) {
    if (SAFE_PARAMS.has(k)) upstream.searchParams.set(k, v);
  }
  if (!upstream.searchParams.has('language')) upstream.searchParams.set('language', 'pt-BR');
  upstream.searchParams.set('include_adult', 'false'); // não negociável pelo cliente

  let up: Response;
  try {
    up = await fetch(upstream.toString(), {
      headers: { Authorization: `Bearer ${await getToken()}`, Accept: 'application/json' },
    });
  } catch {
    return json({ status_message: 'Upstream indisponível' }, 502, origin);
  }

  const long = /^\/(genre|configuration)/.test(path);
  return new Response(up.body, {
    status: up.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${long ? 604800 : 300}`,
      ...corsHeaders(origin),
    },
  });
});
