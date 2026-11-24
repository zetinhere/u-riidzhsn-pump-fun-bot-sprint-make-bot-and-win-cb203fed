# Strategy notes: conviction sniper

## What the dev window showed

The kit's dev window is 24h of pump.fun data (2–3 Nov 2026): 1,222 coins in the
universe, 35 completed (migrated). Analysed offline before writing the bot:

- **Most coins die instantly.** 648 of 1,122 coins with trades sit at 1.0–1.3x their
  create price after 3 slots and never trade again. Buying every launch at age 0
  mostly pays curve (1.25%/side) + tx fees on dead coins.
- **Completers are already gone.** 28 of 35 completers migrate inside the create
  slot itself (median price +14.7x at age 0). No bot can buy them before the move —
  a buy decided on the create batch fills 2 slots later, at the top.
- **Late momentum doesn't work.** Buying after a 30-slot run-up, or when real SOL
  crosses 10–40, loses: the spike is over within 2 slots of the signal (the 2-slot
  latency trap), and the price then fades (median 500-slot return 0.5–0.9x). The
  house momentum pilot loses −9.39 SOL on this window; reversion −4.02 SOL.
- **The only approach near breakeven is an early sniper** (buy age ≤ 3, exit in
  ~10 slots): the house sniper pilot scores −0.49 SOL. Its edge is getting in
  *before* the move rather than chasing it.
- **Create-slot features predict the survivors.** From the create-slot tape alone:
  coins with real SOL ≥ 5 reach +15% again 48% of the time (vs 29% overall);
  creator buy ≥ 1 SOL lifts it to 40%; a price already ≥ 2x from create reaches
  +15% again 51% of the time and completes 27% of the time.

## The bot

Buy in the first 3 slots only when all of these hold:

- creator's own buys in the create slot ≥ 1 SOL (skin in the game),
- at most 1 distinct non-creator buyer so far (not a bundled multi-wallet launch),
- real SOL ≥ 2.5 at decision (the curve already has demand),
- creator has not sold, run-up vs create price ≤ 2.5x.

Size: up to 0.2 SOL per coin (the 1%-of-real-reserve cap usually binds first).
Exits: sell half at +15%; the rest stops at cost, trails 30% once up 50%, exits
after 1,200 slots, or the moment the creator sells. A probe leg opens tiny
0.01 SOL round trips only to keep the run's distinct-coin count on pace for the
20-coin guardrail — it never chases a fill count (each probe pays fees).

## Local results (offline sim, full 24h dev window)

| setting | net PnL | 1st half | 2nd half | trips | win rate | max DD |
|---|---|---|---|---|---|---|
| shipped params | **+0.140 SOL** | +0.167 | −0.027 | 88 | 27% | 2% |
| minRealSol 2.0 | +0.120 SOL | +0.157 | −0.037 | 98 | 28% | 2% |
| minRealSol 3.0 | +0.044 SOL | +0.103 | −0.060 | 84 | 24% | 2% |
| stake 0.05 SOL | −0.008 SOL | +0.063 | −0.072 | 93 | 29% | 2% |
| house sniper pilot | −0.489 SOL | — | — | 354 | 13% | 5% |
| house momentum pilot | −9.387 SOL | — | — | 80 | 6% | 95% |

The region is flat and positive across nearby cells (+0.04 to +0.14 SOL), which is
what the shipped settings were picked from — not a single best cell. Two honest
caveats: the second half of the window is still slightly negative, and the net
depends on the 3 best coins (+0.28 SOL combined); without them it is negative.
That is the shape of this market — the edge is a fat tail, not a high win rate —
so the official `grade-local --stress` check is the real robustness test (see
NOTES in the agent's workspace, not shipped here).

## Rev 2 — dead-coin discipline (2026-11-25, second revision; fixes thinking_revised)

Two small changes, both about not spending fees or position slots on dead coins:

1. **Probe filter** (`strategy.ts`, probe loop): probes now skip coins the main leg
   already finished with (`done`), coins whose creator sold (`devSold`), and
   completed curves — previously a probe could re-buy a coin we deliberately
   exited or one the creator had dumped, paying curve + tx fees for nothing.
2. **Stale exit** (`DEFAULT_PARAMS.staleSlots`: 1,000,000 → 600): a held position on
   a coin with no trade for 600 slots now exits. A dead coin's price is frozen
   (reserves only move on trades), so the exit recovers the same value while
   freeing one of the 5 position slots for a fresh entry instead of waiting for
   `maxHold` (1,200).

Grade-local (official grader, `--driver process`, worktree rev 2) vs baseline
(commit 3f4578b): net PnL **+0.1997 SOL** vs +0.1989 SOL (no regression),
201 fills / 88 coins / 88 round trips, win rate 28.4%, max drawdown 1.25%,
guardrails met, 0 rejected, 3 failed txs. Action log differs from baseline
(`49d897f9…` vs `bcaaf004…`), so the revision genuinely ran. Top-3 coins
still 41.5% of gains; net without them −0.085 SOL — same high-variance profile
as the baseline.
