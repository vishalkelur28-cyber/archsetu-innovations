# @archsetu/core

Language-agnostic static analysis engine. Pure parsing and graph traversal — no AI,
nothing sent over the network.

```ts
import { analyzeRepo, calculateHealthScore } from '@archsetu/core';

const analysis = await analyzeRepo('./my-project');
const health = calculateHealthScore(analysis);

console.log(health.score, health.grade);
```

Full docs, supported languages, and the rest of the API surface are in the
[main repo README](https://github.com/vishalkelur28-cyber/archsetu-innovations#readme).

Looking for a terminal command instead of an API? See
[`@archsetu/cli`](https://www.npmjs.com/package/@archsetu/cli).

## License

MIT
