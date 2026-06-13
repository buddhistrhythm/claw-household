'use strict';

/**
 * background.js — MV3 service worker.
 *
 * On first install, open the options page so the user wires up endpoint + token
 * before the popup is ever clicked. Nothing else to do here — the popup does
 * all the real work; we don't proxy fetches because we don't need to.
 */

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  }
});
