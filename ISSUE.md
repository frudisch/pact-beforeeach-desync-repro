# A failing `beforeEach` permanently desyncs the hook counter and silently disables `beforeEach`/`afterEach` for all later interactions

### Software versions

- **Provider Pact library**: `@pact-foundation/pact` 16.0.4
- **pact-core**: `@pact-foundation/pact-core` 17.1.0 (native FFI 0.4.28, `pact_verifier` 1.3.x)
- **Node**: 24.x
- **OS**: macOS

### Issue Checklist

- [x] I have upgraded to the latest
- [x] I have read the FAQs in the Readme
- [x] I have triple checked that there are no unhandled promises in my code
- [x] I have set my log level to debug and attached a log showing the request/response cycle
- [x] I have created a reproducible repository

### Expected behaviour

`beforeEach` and `afterEach` should run **once per interaction**, independently for
each interaction. If a hook fails for one interaction, that must not affect whether
the hook runs for subsequent interactions.

### Actual behaviour

A single failing `beforeEach` (e.g. a transient error on the first interaction)
**permanently disables `beforeEach` and `afterEach` for every later interaction** —
and, because of a retry, the verification still reports **success**.

With a 3-interaction pact and a `beforeEach` that throws only on interaction 1:

| | `beforeEach` invoked | `afterEach` invoked | interactions verified | result |
|---|---|---|---|---|
| failing `beforeEach` | **1** (expected 3) | **0** (expected 3) | 3/3 | ✅ passes |
| no failure (control) | 3 | 3 | 3/3 | ✅ passes |

This is silent and dangerous: provider-state/`beforeEach` setup never runs for most
interactions, yet the build is green.

### Steps to reproduce

Minimal repo: <link>. Or:

1. A pact with 3 interactions.
2. A `Verifier` whose `beforeEach` throws on its first invocation only.
3. Run `verifyProvider()` with `logLevel: 'debug'`.

### Root cause

The hooks piggyback on the provider-state setup/teardown POSTs to `/_pactSetup`
through a single global counter (`src/dsl/verifier/proxy/hooks.ts`):

```ts
// registerHookStateTracking
if (body?.action === 'setup')    hooksState.setupCounter += 1;
if (body?.action === 'teardown') hooksState.setupCounter -= 1;

// registerBeforeHook -> runs beforeEach when:
body?.action === 'setup'    && hooksState.setupCounter === 1
// registerAfterHook -> runs afterEach when:
body?.action === 'teardown' && hooksState.setupCounter === 0
```

This is correct only if setup/teardown POSTs are perfectly 1:1 balanced for the
whole run. They are not, because:

1. A throwing `beforeEach` calls `next(new Error(...))` → the `/_pactSetup` response
   becomes HTTP **500** (`hooks.ts`).
2. The native core **retries** the failed state-change POST. The retry re-enters
   `registerHookStateTracking` and increments the counter again (`1 → 2`), but
   `beforeEach` is not re-run (it now requires `=== 1`). The retry returns 200 and
   succeeds.
3. The counter floor is now permanently **1**; it oscillates **1↔2** instead of
   **0↔1** for the rest of the run.
4. Every later interaction: `setup` → `1→2` (`beforeEach` requires `1` → skipped);
   `teardown` → `2→1` (`afterEach` requires `0` → skipped).

Debug log excerpt:

```
hooks state counter is 1 after receiving "setup" action      <- I1 setup
executing 'beforeEach' hook
error executing 'beforeEach' hook: transient failure ...      <- 500
hooks state counter is 2 after receiving "setup" action      <- core RETRIES the setup -> desync
hooks state counter is 1 after receiving "teardown" action    <- I1 teardown (floor is now 1)
hooks state counter is 2 after receiving "setup" action      <- I2 setup (beforeEach NOT run)
hooks state counter is 1 after receiving "teardown" action    <- I2 teardown (afterEach NOT run)
hooks state counter is 2 after receiving "setup" action      <- I3 setup (beforeEach NOT run)
hooks state counter is 1 after receiving "teardown" action    <- I3 teardown (afterEach NOT run)
```

More generally, the counter is a global accumulator with no error correction:
**any** unbalanced setup/teardown (a retried setup, a setup whose teardown the core
skips on failure) offsets it permanently.

### Suggested fix

Two complementary changes:

1. **Don't let a hook failure turn into a non-2xx state-change response.** Record
   the hook error and fail `verifyProvider()` at the end instead of `next(err)`.
   This removes the retry/desync trigger entirely.
2. **Replace the global accumulating counter with self-healing, edge-based interaction
   tracking** (e.g. a boolean that flips on the `setup`/`teardown` edges, idempotent
   under retries), so the hooks cannot latch into a permanently-broken state.

### Note — not the same as #924

#924 is the older "stateless interactions are skipped" bug, fixed in the core
(empty-state setup now fires). This is a different defect introduced with the
counter mechanism in #1243: balanced runs work, but any setup retry/failure
permanently desyncs the counter.
