'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const cryptoUtil = require('../src/crypto');

const KEY = 'LIFEOS_SECRET_KEY';

/** Run fn with LIFEOS_SECRET_KEY set/cleared, restoring the prior value after. */
function withKey(value, fn) {
  const prev = process.env[KEY];
  if (value === null) delete process.env[KEY];
  else process.env[KEY] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  }
}

test('crypto: encrypt/decrypt round-trip with a key', () => {
  withKey('unit-test-key-abc', () => {
    assert.equal(cryptoUtil.isEnabled(), true);
    const obj = { last4: '1234', account_number: '000111222333', note: '私密' };
    const token = cryptoUtil.encrypt(obj);
    assert.ok(token.startsWith('enc:'), `expected enc: token, got ${token.slice(0, 12)}`);
    assert.ok(!token.includes('1234'), 'ciphertext must not leak the plaintext');
    assert.deepEqual(cryptoUtil.decrypt(token), obj);

    // strings round-trip too
    const s = cryptoUtil.encrypt('hello world');
    assert.ok(s.startsWith('enc:'));
    assert.equal(cryptoUtil.decrypt(s), 'hello world');
  });
});

test('crypto: without a key, token is plain: and still round-trips', () => {
  withKey(null, () => {
    assert.equal(cryptoUtil.isEnabled(), false);
    const obj = { memo: 'coffee' };
    const token = cryptoUtil.encrypt(obj);
    assert.ok(token.startsWith('plain:'), `expected plain: token, got ${token.slice(0, 12)}`);
    assert.deepEqual(cryptoUtil.decrypt(token), obj);
  });
});

test('crypto: enc: token with no key throws a clear error', () => {
  const token = withKey('a-real-key', () => cryptoUtil.encrypt({ secret: 'x' }));
  assert.ok(token.startsWith('enc:'));
  withKey(null, () => {
    assert.throws(() => cryptoUtil.decrypt(token), /LIFEOS_SECRET_KEY is not set/);
  });
});

test('crypto: plain: token still decrypts even when a key is set', () => {
  const plainToken = withKey(null, () => cryptoUtil.encrypt({ a: 1 }));
  withKey('some-key', () => {
    assert.deepEqual(cryptoUtil.decrypt(plainToken), { a: 1 });
  });
});
