---
name: New language support
about: Request (or claim) support for a language that isn't parsed yet
title: 'Language support: '
labels: language-support
assignees: ''
---

**Language**

e.g. Elixir, Zig, Haskell, ...

**Are you planning to implement this yourself?**

- [ ] Yes, I'd like to work on this - see [CONTRIBUTING.md](../../CONTRIBUTING.md)
      for the walkthrough
- [ ] No, requesting someone else pick it up

**Anything unusual about this language's syntax the parser should know about**

Optional, but genuinely useful - e.g. significant whitespace, multiple ways to
declare a function, unusual comment syntax, etc. Existing parsers
(`packages/core/src/parser/`) are all regex-based rather than full AST parsing, so
syntax quirks that would confuse a simple line-scanner are the most important thing
to flag up front.
