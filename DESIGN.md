# DESIGN — IXIA Guardrails playground

Locked 2026-10-16.

**Inheritance.** The playground is a page of the IXIA product, so it inherits the IXIA app language:
cool blueprint grid on `#e8ebef`, Bricolage Grotesque 800 display + Archivo body + JetBrains Mono labels,
one accent `#2348ff`, semantics green `#11935a` (sent) / amber `#d98309` (held) / red `#e5484d` (blocked).

**Directions considered.**
1. *The gate rail* (chosen): the enquiry passes a vertical rail of checkpoints; each check is a lamp that
   lights in the order and relative timing of the real model trace; the rail ends in a decision bar that
   splits the result into two lanes, "sent to the client now" and "held for a human".
2. *Docket folder*: manila sheets and stamps. Rejected: seals and stamps already used by accountingos,
   ProofGate and ContribPass rows of the ledger; it also breaks consistency with the IXIA app.
3. *Night ops console*: dark telemetry screen. Rejected: neon-on-dark ban, and the product the judges
   would see in the video is light.

**Signature.** The gate rail with lamps + the two-lane split under it. Layout primitive: ruled rows
(checks, how-it-works, eval table, audit chain all use the same hairline row).

**Motion.** Hero H1 masked line reveal (one timeline). While a run is in flight, a scan line travels the
rail. When the result lands, lamps light in sequence scaled from real step timings (≈1.4 s total), then the
decision bar wipes in with `clip-path`. Micro: 160 ms hovers. Reduced motion: everything static.

**Dark mode.** `prefers-color-scheme: dark` swaps to graphite `#0f1218` with the same accent.
