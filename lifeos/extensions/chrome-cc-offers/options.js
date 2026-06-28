'use strict';

/** options.js — read/write endpoint + token to chrome.storage.sync. */

const $endpoint = document.getElementById('endpoint');
const $token = document.getElementById('token');
const $save = document.getElementById('save');
const $ok = document.getElementById('ok');

function load() {
  chrome.storage.sync.get({ endpoint: '', token: '' }, (cfg) => {
    $endpoint.value = cfg.endpoint || '';
    $token.value = cfg.token || '';
  });
}

function save() {
  const endpoint = $endpoint.value.trim().replace(/\/$/, '');
  const token = $token.value.trim();
  chrome.storage.sync.set({ endpoint, token }, () => {
    $ok.textContent = 'Saved.';
    setTimeout(() => { $ok.textContent = ''; }, 1500);
  });
}

$save.addEventListener('click', save);
load();
