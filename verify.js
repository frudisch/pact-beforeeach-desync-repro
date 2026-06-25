/**
 * Reproduction: a failing `beforeEach` desyncs the global hook counter in pact-js
 * and silently disables `beforeEach`/`afterEach` for ALL later interactions.
 *
 * Stack: @pact-foundation/pact 16.0.4 -> @pact-foundation/pact-core 17.1.0 (FFI 0.4.28).
 *
 * The pact has 3 interactions. `beforeEach` fails ONCE (on the first interaction),
 * modelling a transient setup failure. Expected: beforeEach attempted 3x, afterEach 3x.
 * Actual: beforeEach attempted only 1x, afterEach 0x — interactions 2 and 3 are still
 * verified (the provider serves them), but with NO hook ever running.
 */
const path = require('path');
const express = require('express');
const { Verifier } = require('@pact-foundation/pact');

let beforeCalls = 0;
let afterCalls = 0;
const providerRequests = [];

const app = express();
for (const p of ['/one', '/two', '/three']) {
  app.get(p, (_req, res) => {
    providerRequests.push(p);
    res.json({ ok: true });
  });
}

const server = app.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  console.log(`provider listening on http://127.0.0.1:${port}\n`);

  const verifier = new Verifier({
    provider: 'DemoProvider',
    providerBaseUrl: `http://127.0.0.1:${port}`,
    pactUrls: [path.resolve(__dirname, 'pacts', 'DemoConsumer-DemoProvider.json')],
    logLevel: 'debug',
    beforeEach: async () => {
      beforeCalls += 1;
      console.log(`>>> beforeEach invoked (call #${beforeCalls})`);
      // Set NO_THROW=1 to see the healthy control case (all hooks fire 3x).
      if (beforeCalls === 1 && !process.env.NO_THROW) {
        throw new Error('transient failure in beforeEach (interaction 1)');
      }
    },
    afterEach: async () => {
      afterCalls += 1;
      console.log(`<<< afterEach invoked (call #${afterCalls})`);
    },
  });

  try {
    await verifier.verifyProvider();
    console.log('\nverifyProvider() resolved');
  } catch (e) {
    console.log(`\nverifyProvider() rejected: ${e.message}`);
  } finally {
    server.close();
    console.log('\n================ SUMMARY ================');
    console.log(`interactions in pact:      3`);
    console.log(`provider requests served:  ${providerRequests.length}  [${providerRequests.join(', ')}]`);
    console.log(`beforeEach invoked:        ${beforeCalls}   (expected 3)`);
    console.log(`afterEach  invoked:        ${afterCalls}   (expected 3)`);
    console.log('========================================');
  }
});
