# pact-js `beforeEach`/`afterEach` hook-counter desync — minimal repro

A single failing `beforeEach` (a transient error on one interaction) permanently
desyncs pact-js's global hook counter, **silently disabling `beforeEach` and
`afterEach` for every later interaction** — while the verification still passes green.

## Stack

- `@pact-foundation/pact` **16.0.4**
- `@pact-foundation/pact-core` **17.1.0** (native FFI **0.4.28**, `pact_verifier` 1.3.x)

## Run

```bash
npm install
npm run verify            # bug: one transient beforeEach failure
NO_THROW=1 npm run verify # control: no failure
```

## Result

| | `beforeEach` invoked | `afterEach` invoked | interactions verified | build result |
|---|---|---|---|---|
| `npm run verify` (bug)     | **1** (expected 3) | **0** (expected 3) | 3/3 | ✅ **passes** |
| `NO_THROW=1` (control)     | 3 | 3 | 3/3 | ✅ passes |

The pact has 3 interactions. `beforeEach` throws once, on interaction 1.

## Why

The hooks piggyback on the provider-state setup/teardown POSTs to `/_pactSetup`
via a single global counter (`src/dsl/verifier/proxy/hooks.ts`):

- `beforeEach` fires only when `action === 'setup' && setupCounter === 1`
- `afterEach`  fires only when `action === 'teardown' && setupCounter === 0`

Sequence observed in the debug log:

1. I1 `setup` → counter `0→1` → `beforeEach` runs → **throws** → `next(err)` → HTTP **500**.
2. The native core **retries** the failed setup POST. The retry re-enters the
   counter middleware → counter `1→2`. `beforeEach` is *not* re-run (needs `===1`),
   so the retry returns 200 and succeeds.
3. The counter floor is now permanently **1**. It oscillates **1↔2 instead of 0↔1**.
4. For every later interaction: `setup` → `1→2` (`beforeEach` needs `1`, skipped);
   `teardown` → `2→1` (`afterEach` needs `0`, skipped).

Net: one transient hook failure disables both hooks for the rest of the run, and
because the retried setup succeeds, the run reports **success**.

See `ISSUE.md` for the full write-up and a proposed fix.
