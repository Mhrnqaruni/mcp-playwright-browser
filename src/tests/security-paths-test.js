import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { assertAllowedReadPath, assertAllowedWritePath } from '../security/paths.js';

async function main() {
  const allowedRel = 'output/security-test.txt';
  const allowedAbs = await assertAllowedWritePath(allowedRel);
  await fs.writeFile(allowedAbs, 'ok\n', 'utf8');

  const allowedReadAbs = await assertAllowedReadPath(allowedRel);
  assert.equal(allowedReadAbs, allowedAbs);

  const text = await fs.readFile(allowedAbs, 'utf8');
  assert.equal(text.trim(), 'ok');

  let threw = false;
  try {
    await assertAllowedWritePath('../Applied Jobs/security-test.txt');
  } catch {
    threw = true;
  }
  assert.equal(threw, true);

  threw = false;
  try {
    await assertAllowedReadPath('C:\\Windows\\win.ini');
  } catch {
    threw = true;
  }
  assert.equal(threw, true);

  await fs.unlink(allowedAbs);

  console.log('PASS security-paths-test');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

