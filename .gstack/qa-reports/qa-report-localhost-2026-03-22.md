# QA Report — Household Agent

- **Date:** 2026-03-22  
- **URL:** http://localhost:3333/  
- **Branch:** main  
- **Tooling:** gstack browse **unavailable** (`NEEDS_SETUP`); used **Cursor IDE browser MCP** for navigation/snapshot/console.

## Summary

| Metric | Value |
|--------|-------|
| Health score (estimated) | ~85 → ~92 after fix |
| Issues found | 1 critical (HTML) |
| Fixes applied | 1 (verified via served HTML + script presence) |

## ISSUE-001 — Critical: raw `<<<` in HTML broke parser / script execution

- **Severity:** Critical  
- **Category:** Functional / HTML validity  
- **Symptom:** Console: `Uncaught ReferenceError: saveSettingsUi is not defined` (and risk of any function defined after `<script>` not running).  
- **Root cause:** Placeholder text like `<<<MODEL>>>` was embedded **unescaped** in HTML labels/attributes. The HTML parser treats `<` as tag start, corrupting the document tree so the main inline script may not execute fully.  
- **Fix:** Escape placeholders as `&lt;&lt;&lt;MODEL&gt;&gt;&gt;` (etc.) in static HTML and in `placeholder` attributes.  
- **Files:** `skills/public/index.html`  
- **Verification:** `curl http://localhost:3333/` contains `&lt;&lt;&lt;MODEL` and full script with `async function saveSettingsUi`.

## Deferred

- Full **gstack browse** E2E with `$B` (binary not built in this environment).  
- Automated regression test file (no vitest/jest in repo; skill bootstrap skipped).

## PR one-liner

> QA found 1 critical HTML issue (unescaped `<<<` placeholders breaking script load); fixed by entity-escaping LLM/CLI placeholder copy in settings UI.
