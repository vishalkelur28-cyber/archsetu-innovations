# @archsetuweb/cli

Analyze any local codebase from the terminal. No AI, nothing sent over the network —
everything runs on your machine.

```sh
npx @archsetuweb/cli analyze ./my-project
npx @archsetuweb/cli health ./my-project
npx @archsetuweb/cli dead-code ./my-project
```

Add `--json` to any command for machine-readable output.

Full docs are in the
[main repo README](https://github.com/vishalkelur28-cyber/archsetu-innovations#readme).

Want to use the engine directly in your own code instead? `@archsetu/core` isn't
published to npm on its own (this CLI bundles it directly) — see
[`packages/core`](../core) to use it as a library, or copy it into your own project.

## License

MIT
