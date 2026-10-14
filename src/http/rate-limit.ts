/** Limitador simples de janela fixa por chave, em memória (por instância). */
export class FixedWindowLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}

  take(key: string, now = Date.now()): boolean {
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 50_000) this.gc(now);
      return true;
    }
    cur.count++;
    return cur.count <= this.limit;
  }

  private gc(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
