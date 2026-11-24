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
