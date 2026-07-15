/**
 * CINE — Webhook de pagamento (gateway-agnóstico)
 *
 * Recebe notificações do gateway (Kirvano, Cakto, InfinitePay, …), normaliza
 * o evento e atualiza pagamentos + assinaturas. O plano do perfil sincroniza
 * sozinho via trigger no banco. Autenticação: header x-webhook-secret
 * conferido contra o Vault (BILLING_WEBHOOK_SECRET).
 *
 * Formato genérico aceito (configure o gateway para mandar isso, ou use o
 * mapeamento automático de campos comuns de Kirvano/Cakto):
 *   { "event": "approved|pending|refused|refunded|chargeback|canceled",
 *     "email": "...", "plan": "mensal|anual", "amount_cents": 990,
 *     "method": "pix|card|boleto", "ref": "id-no-gateway", "gateway": "kirvano" }
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

let secret: string | null = null;
async function getSecret(): Promise<string> {
  if (!secret) {
    const { data, error } = await admin.rpc('get_billing_secret');
    if (error || !data) throw new Error('BILLING_WEBHOOK_SECRET ausente no Vault');
    secret = data as string;
  }
  return secret;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Caça um valor em vários caminhos possíveis do payload. */
function dig(obj: unknown, paths: string[]): unknown {
  for (const p of paths) {
    let cur: unknown = obj;
    for (const k of p.split('.')) {
      if (cur && typeof cur === 'object' && k in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[k];
      else { cur = undefined; break; }
    }
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
}

function normalize(p: Record<string, unknown>) {
  const rawEvent = String(dig(p, ['event', 'type', 'status', 'data.status']) ?? '').toLowerCase();
  let event = '';
  if (/approved|paid|pago|completed|renewed|renovad|sale_approved|purchase_approved/.test(rawEvent)) event = 'approved';
  else if (/pending|waiting|aguardando|pix_generated|boleto/.test(rawEvent) && !/refus/.test(rawEvent)) event = 'pending';
  else if (/refused|declined|recusad|failed/.test(rawEvent)) event = 'refused';
  else if (/refund|reembols/.test(rawEvent)) event = 'refunded';
  else if (/chargeback/.test(rawEvent)) event = 'chargeback';
  else if (/cancel/.test(rawEvent)) event = 'canceled';

  const email = String(dig(p, ['email', 'customer.email', 'data.customer.email', 'buyer.email']) ?? '').toLowerCase().trim();

  const planRaw = String(dig(p, ['plan', 'plan_code', 'product.name', 'data.product.name', 'products.0.name', 'offer.name', 'data.offer.name']) ?? '').toLowerCase();
  const plan = /anual|yearly|year|12/.test(planRaw) ? 'anual' : 'mensal';

  let amount = Number(dig(p, ['amount_cents']) ?? NaN);
  if (!Number.isFinite(amount)) {
    const v = Number(dig(p, ['amount', 'total_price', 'data.amount', 'purchase.price.value', 'value']) ?? NaN);
    // valores em reais viram centavos; valores já em centavos passam direto
    amount = Number.isFinite(v) ? (v < 1000 && !Number.isInteger(v) ? Math.round(v * 100) : (v < 500 ? Math.round(v * 100) : Math.round(v))) : 0;
  }

  const methodRaw = String(dig(p, ['method', 'payment_method', 'paymentMethod', 'data.payment_method', 'data.paymentMethod', 'payment.method']) ?? '').toLowerCase();
  const method = /pix/.test(methodRaw) ? 'pix' : /card|credit|cartao|cartão/.test(methodRaw) ? 'card' : /boleto|bank_slip/.test(methodRaw) ? 'boleto' : null;

  const ref = String(dig(p, ['ref', 'sale_id', 'transaction_id', 'data.id', 'purchase.transaction', 'id']) ?? '') || null;
  const gateway = String(dig(p, ['gateway', 'platform']) ?? 'gateway');

  return { event, email, plan, amount, method, ref, gateway };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'método não permitido' }, 405);

  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return json({ error: 'json inválido' }, 400); }

  // O segredo pode vir no header, na query string ou no corpo
  // (a Cakto manda a "Chave secreta" dentro do payload, campo `secret`).
  const given = req.headers.get('x-webhook-secret')
    ?? new URL(req.url).searchParams.get('secret')
    ?? String(payload.secret ?? '');
  if (given !== await getSecret()) return json({ error: 'não autorizado' }, 401);

  const n = normalize(payload);
  if (!n.event) return json({ ok: true, ignored: 'evento desconhecido' });
  if (!n.email) return json({ error: 'email do cliente ausente' }, 422);

  const { data: prof } = await admin.from('profiles').select('id').eq('email', n.email).maybeSingle();
  if (!prof) return json({ error: 'usuário não encontrado: ' + n.email }, 404);
  const userId = prof.id as string;

  if (n.event === 'approved') {
    // renova a assinatura existente do mesmo gateway ou cria uma nova
    const days = n.plan === 'anual' ? 365 : 30;
    const { data: sub } = await admin.from('subscriptions').select('id')
      .eq('user_id', userId).in('status', ['trial', 'active', 'past_due'])
      .order('current_period_end', { ascending: false }).limit(1).maybeSingle();
    let subId = sub?.id as number | undefined;
    const periodEnd = new Date(Date.now() + days * 864e5).toISOString();
    if (subId) {
      await admin.from('subscriptions').update({
        status: 'active', plan_code: n.plan, gateway: n.gateway, gateway_ref: n.ref,
        current_period_end: periodEnd, cancel_at_period_end: false,
      }).eq('id', subId);
    } else {
      const { data: created } = await admin.from('subscriptions').insert({
        user_id: userId, plan_code: n.plan, status: 'active',
        gateway: n.gateway, gateway_ref: n.ref, current_period_end: periodEnd,
      }).select('id').single();
      subId = created?.id;
    }
    await admin.from('payments').insert({
      user_id: userId, subscription_id: subId ?? null, plan_code: n.plan,
      amount_cents: n.amount, method: n.method, status: 'approved',
      gateway: n.gateway, gateway_ref: n.ref, paid_at: new Date().toISOString(),
    });
    return json({ ok: true, action: 'ativado', plano: n.plan });
  }

  if (n.event === 'pending' || n.event === 'refused') {
    await admin.from('payments').insert({
      user_id: userId, plan_code: n.plan, amount_cents: n.amount, method: n.method,
      status: n.event, gateway: n.gateway, gateway_ref: n.ref,
    });
    return json({ ok: true, action: n.event });
  }

  if (n.event === 'refunded' || n.event === 'chargeback') {
    if (n.ref) {
      await admin.from('payments').update({ status: n.event })
        .eq('gateway_ref', n.ref).eq('status', 'approved');
    }
    await admin.from('subscriptions').update({ status: 'canceled', canceled_at: new Date().toISOString() })
      .eq('user_id', userId).in('status', ['trial', 'active', 'past_due']);
    return json({ ok: true, action: n.event });
  }

  if (n.event === 'canceled') {
    // gateway avisa que a recorrência morreu: deixa valer até o fim do período
    await admin.from('subscriptions').update({ cancel_at_period_end: true })
      .eq('user_id', userId).in('status', ['trial', 'active']);
    return json({ ok: true, action: 'cancelamento agendado' });
  }

  return json({ ok: true, ignored: n.event });
});
