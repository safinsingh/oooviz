# Pipeline demonstrations

Serve `dist` with any static server (for example `python3 -m http.server 8000 --directory dist`). Run verification with `node --test tests/pipeline.test.mjs`.

| Page | Issue / completion | Intended lesson |
| --- | --- | --- |
| `index.html` | In order / in order | Uniform, one-cycle EX; no data dependencies or stalls. |
| `variable.html` | In order / out of order | Variable EX with unchecked WAW and single-slot WB collisions. |
| `stalls.html` | In order / out of order | Stall ID only when a younger write could complete before/equal to an older same-register write, or collide at WB. |
| `long-latency.html` | In order / out of order | Add reads and RAW interlocks; independent younger work cannot bypass blocked ID. |
| `out-of-order.html` | Oldest ready / out of order | A four-entry issue queue avoids head-of-line blocking. RAW, WAW and WB checks remain; WAR is deliberately unchecked. |

## Timing contract

- Each step advances EX, enters completed instructions into WB, then issues at most one instruction. An instruction issued at cycle C with EX latency L enters WB at C + L.
- Operands are captured at issue. WB at a boundary is visible to operand reads at that same boundary. RAW therefore releases at the producer's WB cycle. A younger writer entering WB on an older reader's issue cycle is already a WAR violation.
- EX is fully pipelined with enough execution capacity for all overlapping instructions. The structural limit illustrated here is one WB/completion slot per cycle, used by reads as well as writes.
- Safe issue reserves that future WB cycle. A younger same-register writer may overlap an older writer if it completes strictly later. WAW checks also cover older unissued writes in the out-of-order queue.
- A blocked in-order ID freezes IF and all incoming instructions; EX and WB continue. The out-of-order frontend advances until the four-entry issue queue fills.
- Stall labels describe the **next** issue boundary, using the same checks as the scheduler. Head-of-line highlighting includes only younger instructions which would otherwise satisfy the dependency and WB checks.
- WAR highlighting records an actual younger write before an older operand read, retaining the writer identity until the affected reader leaves WB. It does not speculate by simulating future instructions and never adds a WAR stall.
- The table's WB cycle is entry into WB. CPI counts instructions that have left WB. No reorder buffer or in-order retirement is modeled.
- `x0`–`x3` are generic writable registers, not RISC-V architectural register semantics. Instructions are abstract reads or writes; operand values are not simulated.

## Verification

The regression suite covers each teaching scenario, exact release boundaries, frontend backpressure, same-cycle reads, false WAR avoidance, deterministic random streams and 43,400 variable-pipeline cycles across 31 seeds. It checks single-slot WB and ordered same-register writes on interlocked pages, RAW readiness, issue ordering and snapshot/step agreement. Unsafe pages deliberately retain their illustrated hazards.
