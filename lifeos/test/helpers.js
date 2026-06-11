'use strict';

const crypto = require('crypto');
const { createStore } = require('../src/store');

/** Spin up a store in a throwaway schema for test isolation. */
async function freshStore() {
  const schema = 'test_' + crypto.randomBytes(5).toString('hex');
  const store = await createStore({ schema });
  const origClose = store.close;
  store.close = async () => { await store.drop(); await origClose(); };
  return store;
}

module.exports = { freshStore };
