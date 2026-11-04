import type { LeashConfig } from "./policy/schema.js";
import type { OrderIntent, Quote } from "./types.js";
import type { ShadowOrder, ShadowState } from "./state.js";
import { round, uuid } from "./util.js";

export function newShadowState(startingCash: number): ShadowState {
  return { cash: startingCash, positions: {}, orders: [], startingCash, hwmEquity: startingCash, realizedPnl: 0 };
}

export interface ShadowFillResult {
  order: ShadowOrder;
  /** Reason when status is "rejected". */
  rejection?: string;
}

/**
 * Simulated broker used at the shadow rung. Orders fill against LIVE quotes (supplied by the real broker)
 * with a slippage and fee model; nothing is ever sent to a broker. The model is deliberately simple:
 * market orders fill at the touch plus slippage, limit orders fill only when marketable and otherwise rest
 * until `mark` sees a crossing quote. It does not model queue position, partial fills or market impact, so
 * shadow P&L is optimistic evidence about behaviour, not a forecast of live returns.
 */
export class ShadowLedger {
  constructor(
    private readonly state: ShadowState,
    private readonly cfg: LeashConfig["shadow"],
    private readonly now: () => Date = () => new Date(),
  ) {}

  get snapshot(): ShadowState {
    return this.state;
  }

  equity(marks: Record<string, number>): number {
    let eq = this.state.cash;
    for (const [sym, p] of Object.entries(this.state.positions)) {
      const px = marks[sym] ?? p.avgPrice;
      eq += p.qty * px;
    }
    return round(eq, 4);
  }

  submit(intent: OrderIntent, quote: Quote, qtyOverride?: number): ShadowFillResult {
    const nowIso = this.now().toISOString();
    const price = intent.side === "buy" ? quote.ask : quote.bid;
    const qty = qtyOverride ?? intent.qty ?? (intent.notionalUsd !== undefined && price > 0 ? intent.notionalUsd / price : 0);
    const base: ShadowOrder = {
      id: uuid(),
      symbol: intent.symbol,
      side: intent.side,
      type: intent.type,
      qty,
      status: "open",
      filledQty: 0,
      fee: 0,
      submittedAt: nowIso,
      ...(intent.limitPrice !== undefined ? { limitPrice: intent.limitPrice } : {}),
    };
    if (!(qty > 0) || !(price > 0)) {
      base.status = "rejected";
      this.state.orders.push(base);
      return { order: base, rejection: "Order quantity or price is not positive." };
    }
    if (intent.type === "stop" || intent.type === "stop_limit") {
      base.status = "rejected";
      this.state.orders.push(base);
      return { order: base, rejection: `Shadow ledger does not simulate ${intent.type} orders yet.` };
    }
    const marketable =
      intent.type === "market" ||
      (intent.limitPrice !== undefined && (intent.side === "buy" ? intent.limitPrice >= quote.ask : intent.limitPrice <= quote.bid));
    if (!marketable) {
      this.state.orders.push(base);
      return { order: base };
    }
    return this.fill(base, quote, intent.type === "limit" ? intent.limitPrice : undefined);
  }

  private fill(order: ShadowOrder, quote: Quote, limit?: number): ShadowFillResult {
    const slip = this.cfg.slippageBps / 10_000;
    const touch = order.side === "buy" ? quote.ask : quote.bid;
    let px = order.side === "buy" ? touch * (1 + slip) : touch * (1 - slip);
    if (limit !== undefined) px = order.side === "buy" ? Math.min(px, limit) : Math.max(px, limit);
    const gross = px * order.qty;
    const fee = (gross * this.cfg.feeBps) / 10_000;
    if (order.side === "buy") {
      if (this.state.cash < gross + fee) {
        order.status = "rejected";
        this.state.orders.push(order);
        return { order, rejection: `Insufficient shadow cash ($${this.state.cash.toFixed(2)}) for $${(gross + fee).toFixed(2)}.` };
      }
      this.state.cash -= gross + fee;
      const p = this.state.positions[order.symbol] ?? { qty: 0, avgPrice: 0 };
      const newQty = p.qty + order.qty;
      p.avgPrice = (p.avgPrice * p.qty + gross) / newQty;
      p.qty = newQty;
      this.state.positions[order.symbol] = p;
    } else {
      const p = this.state.positions[order.symbol];
      if (!p || p.qty + 1e-12 < order.qty) {
        order.status = "rejected";
        this.state.orders.push(order);
        return { order, rejection: `Insufficient shadow position in ${order.symbol} to sell ${order.qty}.` };
      }
      this.state.cash += gross - fee;
      this.state.realizedPnl += (px - p.avgPrice) * order.qty - fee;
      p.qty -= order.qty;
      if (p.qty < 1e-12) delete this.state.positions[order.symbol];
    }
    order.status = "filled";
    order.filledQty = order.qty;
    order.filledAvgPrice = px;
    order.fee = fee;
    order.filledAt = this.now().toISOString();
    this.state.orders.push(order);
    return { order };
  }

  /** Try to fill resting limit orders against fresh quotes. Returns the orders that filled. */
  mark(quotes: Record<string, Quote>): ShadowOrder[] {
    const filled: ShadowOrder[] = [];
    for (const o of this.state.orders) {
      if (o.status !== "open") continue;
      const q = quotes[o.symbol];
      if (!q || o.limitPrice === undefined) continue;
      const crosses = o.side === "buy" ? o.limitPrice >= q.ask : o.limitPrice <= q.bid;
      if (!crosses) continue;
      // Remove the open copy and re-run the fill so cash and positions update once.
      this.state.orders = this.state.orders.filter((x) => x !== o);
      const res = this.fill({ ...o, status: "open" }, q, o.limitPrice);
      if (res.order.status === "filled") filled.push(res.order);
    }
    return filled;
  }

  cancel(id: string): ShadowOrder | undefined {
    const o = this.state.orders.find((x) => x.id === id);
    if (o && o.status === "open") o.status = "canceled";
    return o;
  }

  cancelAll(): number {
    let n = 0;
    for (const o of this.state.orders) {
      if (o.status === "open") {
        o.status = "canceled";
        n++;
      }
    }
    return n;
  }

  /** Update the high-water mark and return the drawdown from it, in percent. */
  drawdownPct(marks: Record<string, number>): { equity: number; hwm: number; pct: number } {
    const equity = this.equity(marks);
    if (equity > this.state.hwmEquity) this.state.hwmEquity = equity;
    const hwm = this.state.hwmEquity;
    return { equity, hwm, pct: hwm > 0 ? round(((hwm - equity) / hwm) * 100, 4) : 0 };
  }
}
