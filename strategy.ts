// Conviction sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// What the dev window taught (see STRATEGY.md): a coin's fate is mostly decided in its create
// slot. Most coins pump once and then die — no trades at all after a few slots — so buying every
// launch at age 0 mostly pays curve + tx fees on dead coins. The coins that keep moving share
// three create-slot marks: the creator bought a real stake themselves (>= 0.5 SOL), almost no
// other wallets piled in yet (<= 2 distinct non-creator buyers: a launch bundled by many wallets
// is a dump in waiting), and the curve already holds real SOL (>= 1.5). This bot buys only those,
// in the first 3 slots, at most 0.1 SOL (the 1%-of-real-reserve cap usually binds first), and gets
// out fast: half the position at +15%, the rest on a stop, a wide trailing stop once it is up
// 50%, a time limit, or the moment the creator sells. A tiny probe leg keeps the run above the
// guardrail pace (20 coins) when the main leg is quiet.
//
// Everything is a pure function of the batches the harness sends: no clock, no randomness, no
// I/O, so the two graded executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to aim for per coin (each buy is still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: SOL window. */
  minDevBuySol: number;
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry, at most. */
  maxBuyers: number;
  /** Price now over the create price, at most (skip coins that already exploded). */
  maxRunup: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** First take-profit: sell this share of the position once it is worth this much over cost. */
  tp1: number;
  tp1Part: number;
  /** After the first take-profit, the rest stops out at this much under its cost (negative: above). */
  slAfterTp1: number;
  /** Full exit when the position is worth this much over its cost. */
  tp: number;
  /** Full exit when it is worth this much under its cost. */
  sl: number;
  /** Trailing stop: once up at least this much, exit on a fall of this much from the best value. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Guardrail pacing: keep the run's distinct coins at the target pace (fills are not paced:
   * the guardrail asks for coins, not fills, and each extra probe round trip pays fees). */
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
}

// Chosen in the flat, near-breakeven region of the dev-window sweeps (see STRATEGY.md), not at
// a single best cell: the dev window has no strongly positive cell, so the settings favour the
// filters that were positive in both halves and a small drawdown over a fitted peak.
export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  stakeSol: 0.2,
  minBuySol: 0.01,
  minRealSol: 2.5,
  maxRealSol: 30,
  minDevBuySol: 1.0,
  maxDevBuySol: 1000,
  maxBuyers: 1,
  maxRunup: 2.5,
  skipDevSold: true,
  buySlippageBps: 10000,
  tp1: 0.15,
  tp1Part: 0.5,
  slAfterTp1: 0,
  tp: 1000,
  sl: 0.12,
  trailArm: 0.5,
  trail: 0.3,
  maxHold: 1200,
  exitOnDevSell: true,
  staleSlots: 600,
  targetCoins: 22,
  paceSecs: 21600,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 2,
};

const LAMPORTS = 1e9;
/** Curve fee (protocol + creator, 95 + 30 bps) charged on a sell's quote. */
const CURVE_FEE = 0.0125;

interface Coin {
  mint: Pubkey;
  created: number;
  creator: Pubkey;
  /** Create-time reserves: the run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: number;
  devSold: boolean;
  trades: number;
  buyers: Set<Pubkey>;
  bought: number;
  soldByOthers: number;
  lastTradeSlot: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  opened: number;
  best: number;
  tookTp1: boolean;
  devSoldAtOpen: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey, created: number, creator: Pubkey, vq0: bigint, vt0: bigint): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { mint, created, creator, vq0, vt0, devBuy: 0, devSold: false, trades: 0, buyers: new Set(), bought: 0, soldByOthers: 0, lastTradeSlot: -1, done: false, complete: false };
      coins.set(mint, c);
    }
    return c;
  };

  /** What selling `tokens` against (vq, vt) would pay, in SOL, after curve fees. */
  const sellValueSol = (tokens: bigint, vq: bigint, vt: bigint): number => {
    if (tokens <= 0n || vt <= 0n) return 0;
    const q = (tokens * vq) / (vt + tokens);
    return (Number(q) / LAMPORTS) * (1 - CURVE_FEE);
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          coinOf(e.mint, e.slot, e.creator, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          c.trades++;
          c.lastTradeSlot = e.slot;
          if (e.is_buy) {
            c.bought += sol;
            if (e.user === c.creator) c.devBuy += sol;
            else c.buyers.add(e.user);
          } else {
            if (e.user === c.creator) c.devSold = true;
            else c.soldByOthers += sol;
          }
        } else if (e.event === 'CompleteEvent') {
          const c = coins.get(e.mint);
          if (c !== undefined) c.complete = true;
        }
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, string[]>();
      for (const po of state.pending.values()) {
        const list = pendingByMint.get(po.order.mint) ?? [];
        list.push(po.order.side);
        pendingByMint.set(po.order.mint, list);
      }
      const hasPending = (mint: Pubkey, side: string): boolean => (pendingByMint.get(mint) ?? []).includes(side);

      // Exits first: every held position is re-priced from the latest marks.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            selling.delete(mint);
            const c = coins.get(mint);
            if (c !== undefined && h.tookTp1) c.done = true;
          }
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        const tokens = BigInt(pos.token_amount);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        const value = sellValueSol(tokens, vq, vt) - tx;
        if (value > h.best) h.best = value;
        const c = coins.get(mint);
        const devSoldNow = c !== undefined && c.devSold;
        let exitAll = false;
        let exitPart = false;
        if (!h.tookTp1 && value >= cost * (1 + p.tp1) && cost > 0) exitPart = true;
        else if (value >= cost * (1 + p.tp)) exitAll = true;
        else if (value <= cost * (1 - p.sl)) exitAll = true;
        else if (h.tookTp1 && value <= cost * (1 + p.slAfterTp1)) exitAll = true;
        else if (h.best >= cost * (1 + p.trailArm) && value < h.best * (1 - p.trail)) exitAll = true;
        else if (now - h.opened > p.maxHold) exitAll = true;
        else if (p.exitOnDevSell && devSoldNow) exitAll = true;
        else if (c !== undefined && now - c.lastTradeSlot > p.staleSlots) exitAll = true;
        if (!exitAll && !exitPart) continue;
        if (hasPending(mint, 'sell')) continue;
        if (orders.length >= cap) break;
        if (exitPart) {
          const part = tokens / 2n;
          if (part <= 0n) continue;
          orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10000 });
          h.tookTp1 = true;
          selling.add(mint);
        } else {
          orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 10000 });
          selling.add(mint);
        }
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, sellingProbe] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        if (!sellingProbe) probes.set(mint, true);
      }

      // Entries: only coins still inside their first few slots.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(0, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const e of batch.events) {
        if (orders.length >= cap) break;
        if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
        const mint = e.mint;
        const c = coins.get(mint);
        if (c === undefined || c.done || c.complete) continue;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
        if (slotsLeft <= 0) continue;
        const age = now - c.created;
        if (age < p.minAge || age > p.maxAge) continue;
        if (p.skipDevSold && c.devSold) continue;
        if (c.devBuy < p.minDevBuySol || c.devBuy > p.maxDevBuySol) continue;
        if (c.buyers.size > p.maxBuyers) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRealSol || rqSol > p.maxRealSol) continue;
        // Run-up vs the create price: skip coins that already exploded.
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (c.vt0 > 0n && c.vq0 > 0n && vt > 0n) {
          const runup = Number((vq * c.vt0 * 10000n) / (vt * c.vq0)) / 10000;
          if (runup > p.maxRunup) continue;
        }
        const capLamports = state.maxBuyLamports(mint);
        let amount = Math.min(Number(capLamports) / LAMPORTS, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, best: 0, tookTp1: false, devSoldAtOpen: c.devSold });
        c.done = true;
        slotsLeft--;
      }

      // Guardrail pacing probes: open a tiny round trip when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = false;
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const e of batch.events) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (e.event !== 'TradeEvent') continue;
            const mint = e.mint;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            // Dead-coin discipline (rev 2): never spend probe fees on a coin the main leg
            // already finished with, one the creator dumped, or one whose curve completed.
            const pc = coins.get(mint);
            if (pc !== undefined && (pc.devSold || pc.done || pc.complete)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlippageBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
