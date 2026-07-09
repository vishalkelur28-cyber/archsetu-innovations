---
name: Feature request
about: Suggest an analysis capability or CLI improvement
title: ''
labels: enhancement
assignees: ''
---

**What would this let you do that you can't today**

Concrete over abstract - "I want to find X in my codebase" is more useful than
"add more metrics."

**Where should this live**

- [ ] `@archsetu/core` (new analysis capability, exported for any consumer)
- [ ] `@archsetu/cli` (new command or flag on an existing command)
- [ ] Not sure

**Would this need per-language work, or is it language-agnostic**

Some analysis (health scoring, call graph traversal) works on already-parsed output
and needs no language-specific code. Others (a new kind of syntax detection) would
need updating every parser. Knowing which one this is up front helps scope it.
