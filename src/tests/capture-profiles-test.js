import assert from 'node:assert/strict';

import {
  getCaptureDefaults,
  getCaptureProfile,
  listCaptureProfiles,
  normalizeCaptureProfile
} from '../browser/capture-profiles.js';

function main() {
  const profiles = listCaptureProfiles();
  assert.deepEqual(profiles, ['light', 'balanced', 'full']);

  assert.equal(normalizeCaptureProfile('LIGHT'), 'light');
  assert.equal(normalizeCaptureProfile('balanced'), 'balanced');
  assert.equal(normalizeCaptureProfile('unknown-profile'), 'light');

  const lightQueryLow = getCaptureDefaults('light', 'query_dom', 'low');
  assert.equal(lightQueryLow.limit, 20);
  assert.equal(lightQueryLow.includeBBox, false);
  assert.equal(lightQueryLow.includeState, false);
  assert.equal(lightQueryLow.includeText, true);

  const lightQueryHigh = getCaptureDefaults('light', 'query_dom', 'high');
  assert.equal(lightQueryHigh.limit > lightQueryLow.limit, true);
  assert.equal(lightQueryHigh.includeText, true);

  const balancedListLow = getCaptureDefaults('balanced', 'list', 'low');
  assert.equal(balancedListLow.maxItems, 240);
  assert.equal(balancedListLow.viewportOnly, false);

  const fullTakeHigh = getCaptureDefaults('full', 'take_snapshot', 'high');
  assert.equal(fullTakeHigh.interestingOnly, false);
  assert.equal(fullTakeHigh.maxNodes >= 2000, true);

  const profileObj = getCaptureProfile('light');
  assert.ok(profileObj && typeof profileObj === 'object');

  // Returned defaults should be copies, not shared mutable references.
  lightQueryLow.limit = 9999;
  const fresh = getCaptureDefaults('light', 'query_dom', 'low');
  assert.equal(fresh.limit, 20);

  console.log('PASS capture-profiles-test');
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
