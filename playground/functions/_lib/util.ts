export interface Env {
  AI: { run: (model: string, input: any) => Promise<any> };
  RATE: KVNamespace;
  DAILY_LIVE_RUNS?: string;
  PER_IP_PER_DAY?: string;
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

// Best-effort daily caps in KV (eventually consistent; good enough to keep a
// public demo inside the free Workers AI allocation).
export async function takeBudget(env: Env, ip: string): Promise<{ ok: boolean; reason?: string; left?: number }> {
  const day = new Date().toISOString().slice(0, 10);
  const gKey = `g:${day}`;
  const iKey = `ip:${day}:${ip}`;
  const [g, i] = await Promise.all([env.RATE.get(gKey), env.RATE.get(iKey)]);
  const gN = Number(g || 0), iN = Number(i || 0);
  const gMax = limit(env.DAILY_LIVE_RUNS, 120), iMax = limit(env.PER_IP_PER_DAY, 25);
  if (gN >= gMax) return { ok: false, reason: 'daily_budget' };
  if (iN >= iMax) return { ok: false, reason: 'per_visitor_budget' };
  await Promise.all([
    env.RATE.put(gKey, String(gN + 1), { expirationTtl: 172800 }),
    env.RATE.put(iKey, String(iN + 1), { expirationTtl: 172800 }),
  ]);
  return { ok: true, left: gMax - gN - 1 };
}

// A mistyped limit ("25/day", "") must not switch the cap off: NaN compares
// false with everything, so it used to mean unlimited.
function limit(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}
