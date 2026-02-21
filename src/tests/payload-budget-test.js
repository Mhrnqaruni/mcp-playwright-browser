import assert from 'node:assert/strict';

import { enforcePayloadCeiling } from '../browser/payload-budget.js';

function makeLargePayload() {
  const items = [];
  for (let i = 0; i < 500; i += 1) {
    items.push({
      id: i + 1,
      text: `item-${i}`.repeat(40),
      href: `https://example.com/${i}`,
      attrs: {
        a: 'x'.repeat(120),
        b: 'y'.repeat(120),
        c: 'z'.repeat(120)
      }
    });
  }

  return {
    ok: true,
    requestId: 'req-test',
    timestamp: new Date().toISOString(),
    pageId: 1,
    url: 'https://example.com',
    title: 'Example',
    domVersion: 'p1:main@1',
    activeFrameId: 'main',
    status: 'test',
    text: 'A'.repeat(20000),
    items
  };
}

function main() {
  const small = {
    ok: true,
    requestId: 'req-small',
    timestamp: new Date().toISOString(),
    pageId: 1,
    url: 'https://example.com',
    title: 'Small',
    domVersion: 'p1:main@1',
    activeFrameId: 'main',
    items: [{ id: 1, text: 'hello' }]
  };

  const under = enforcePayloadCeiling(small, { maxBytes: 200000 });
  assert.equal(under.truncated, false);
  assert.equal(under.finalBytes <= 200000, true);

  const large = makeLargePayload();
  const over = enforcePayloadCeiling(large, { maxBytes: 12000 });
  assert.equal(over.truncated, true);
  assert.equal(over.finalBytes <= 12000, true);
  assert.equal(over.payload.ok, true);
  assert.equal(typeof over.payload.requestId, 'string');
  assert.equal(over.payload.truncated, true);
  assert.equal(typeof over.payload.maxPayloadBytes, 'number');
  assert.ok(over.payload.retryWith);

  // Regression: oversized envelope fields must still honor the global cap.
  const hugeEnvelope = {
    ok: true,
    requestId: 'r'.repeat(4000),
    timestamp: new Date().toISOString(),
    pageId: 1,
    url: 'https://example.com/' + 'u'.repeat(500000),
    title: 't'.repeat(250000),
    domVersion: 'p1:main@1',
    activeFrameId: 'main',
    status: 'overflow-test',
    items: [{ id: 1, text: 'x'.repeat(200000) }]
  };
  const hardCap = enforcePayloadCeiling(hugeEnvelope, { maxBytes: 12000 });
  assert.equal(hardCap.truncated, true);
  assert.equal(hardCap.finalBytes <= 12000, true);
  assert.equal(typeof hardCap.payload.truncated, 'boolean');

  console.log('PASS payload-budget-test');
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
