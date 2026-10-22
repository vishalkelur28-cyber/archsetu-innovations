# @archsetuweb/cli

Static analysis for any codebase on your machine, as a CLI and as an [MCP](https://modelcontextprotocol.io) server.

Everything runs locally. No account, no API key, and your source files are never uploaded. Two
commands talk to the network. `share` publishes a page about a project, is described below, and sends
measurements and the text you see printed first. `submit` uploads an analysis result to archsetu.com
(function names, paths and measurements, plus the line each security finding flags, with any secret
on it masked) and checks the versions of your declared dependencies against OSV.dev. Every other
command, `review` and the MCP server included, makes no network request.

Requires Node.js 20 or newer.

---

## As an MCP server: let your coding agent ask what it is about to break

A coding agent editing your code has no cheap way to know that the function it is refactoring has two hundred callers across a dozen files. This gives it eleven read-only tools to ask with.

Add it to your client:

**Claude Code**

```bash
claude mcp add archsetu --scope project -- npx -y @archsetuweb/cli@latest mcp .
```

`--scope project` writes `.mcp.json` so your team gets it too. Drop it to keep the server to yourself.

**Cursor** - `.cursor/mcp.json` in your project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "archsetu": {
      "command": "npx",
      "args": ["-y", "@archsetuweb/cli@latest", "mcp", "."]
    }
  }
}
```

**Claude Desktop** - `claude_desktop_config.json`. A desktop app has no project directory, so give it an absolute path rather than `.`:

```json
{
  "mcpServers": {
    "archsetu": {
      "command": "npx",
      "args": ["-y", "@archsetuweb/cli@latest", "mcp", "/absolute/path/to/your/repo"]
    }
  }
}
```

Any client that can launch a subprocess works: the server speaks newline-delimited JSON-RPC over stdin and stdout.

### The tools

| Tool | Answers |
| --- | --- |
| `repo_overview` | What is this codebase? Health score, size, languages, entry points, risk counts. |
| `function_blast_radius` | What breaks if I change this function? Callers, files spanned, which are entry points. |
| `file_blast_radius` | What breaks if I change this file? Direct and transitive importers. |
| `explain_file` | What does this one file do? Purpose, imports, exports, functions with line numbers. |
| `dead_code` | What here is unreachable? |
| `complexity_hotspots` | Where is this hard to change? |
| `security_findings` | What looks unsafe? Secrets, unsafe eval, string-built SQL, and more. Secret values are masked. |
| `test_risk` | What is risky and untested? |
| `dependency_hygiene` | Why does this break in CI? Imports that are never declared in a manifest. |
| `ownership_risk` | Who knows this code? Bus factor, contributors, churn. |
| `onboarding_guide` | Where do I start reading? |

Every tool is read-only and declares itself as such, so a client can auto-approve them without granting write access. There is no tool that writes, moves or deletes.

### Check that it works

Editors report a failed MCP server as a line in a log you have to go looking for, and it usually just
says the server exited. So before you add it to a client, or when a client says it is broken:

```bash
npx -y @archsetuweb/cli@latest mcp --check /absolute/path/to/your/repo
```

That starts a server and talks to it exactly as your client would: handshake, tool list, a real
analysis of that repository, and a path it should refuse, then tells you what worked:

```
ArchSetu MCP self-check
  version    0.1.23
  node       v22.15.0
  repository /home/you/your-repo

  ok   Starts and speaks the current protocol (2026-07-28)
  ok   Offers its tools, all declared read-only (11 tools)
  ok   Analyzed your repository (your-repo: health 72/100 (grade B), 1204 functions across 310 files...)
  ok   Refuses to read outside the directories you allowed
  ok   Also answers clients still using the older handshake (2025-11-25)
  ok   Kept stdout clean for the protocol

Everything works.
```

Read the analysis line rather than just the green. If it says 0 files, the server is working perfectly
on the wrong directory, which is the most common setup problem, because a client launches the server
from its own working directory, not your project's. That is why the command is worth giving an absolute
path even when `.` would seem to do.

It exits 0 when everything passes and 1 when it does not, so it also works in CI.

### Options

```
archsetu mcp [dir]                 # the repository to allow (default: current directory)
  --root <dir>                     # allow another repository (repeatable)
  --cache-ttl <seconds>            # how long a cached analysis is served (default: 120)
  --max-files <n>                  # cap files analyzed per repository
  --check                          # don't serve: test the setup and report (see above)
```

The server reads **only** inside the directories you launch it with. Any path outside them is refused, symlinks resolved first. This matters because tool arguments are chosen by a model whose context includes your repository's own text, so a README cannot talk an agent into reading your home directory. Changing what is readable means restarting the server with different arguments.

Running `archsetu mcp` by hand starts a server that waits on stdin and does nothing visible: it is meant to be launched by a client. Ctrl+C to stop it. Use `--check` above if what you want is to find out whether it works.

### Protocol

Implements MCP revision `2026-07-28`, where each request carries its own protocol version and the server holds no session state. It also still answers the older `initialize` handshake used by `2025-11-25`, `2025-06-18` and `2025-03-26`. The two eras are not interoperable and a handshake-era client has no way to adapt, so the server answers both and decides per request.

---

## `review`: what a change touches, before you merge it

```bash
npx -y @archsetuweb/cli@latest review --base origin/main
```

A diff shows which lines changed. It does not show what depends on the functions those lines are in.
`review` parses the whole repository, builds its call graph, and reports only what your change touched,
so the repository's existing problems never show up as yours:

- each changed function, with its direct callers, every function that reaches it within 3 calls, a risk grade from that count, and its complexity before and after;
- security findings on the lines you changed;
- functions the change added or made more complex that are now critically complex (above 20);
- new private functions that nothing calls;
- packages newly imported in a JavaScript or TypeScript file that no `package.json` declares.

It compares against the point where your branch left `--base` (the merge base), so work that landed on
the base since does not count as yours. Uncommitted and untracked files are part of the change, so you
can run it before you commit. Nothing is uploaded.

Run on [PocketBase](https://github.com/pocketbase/pocketbase) at commit `5cdbca2`, which tightened its
CORS wildcard matching:

```
$ archsetu review --base HEAD~1

──── ArchSetu review ────
Compared with 768087993ece (HEAD~1)

2 functions changed
  exactWildcardMatch apis/middlewares_cors.go:287
    added, direct callers: 2 in 2 files, within 3 calls: 5 functions in 5 files, risk medium, complexity 11 (new)
  CORS apis/middlewares_cors.go:131
    modified, direct callers: 1 in 1 file, within 3 calls: 3 functions in 3 files, risk medium, complexity 33
```

That commit renamed `matchSubdomain` to `exactWildcardMatch`. A function is paired with its earlier
version by name, so a rename reads as added. Its two direct callers are `CORS` and the test the same
commit added.

The report is deterministic: the same change against the same base always gives the same numbers, so a
count that moves between pushes moved because the code did. Every count comes with the callers behind
it (in `--json`, and folded under the table with `--markdown`), so any number can be checked. Callers are
matched by name, and a caller in another file counts only where it could see the function: a function
that is not exported counts callers in its own directory, and one whose name other files also declare
counts callers further away only where an import shows which one they mean. Dynamic calls are
invisible, so read the counts as a lower bound (see [What it will not tell you](#what-it-will-not-tell-you)).

### Options

```
archsetu review [dir]              # report only changes inside this directory (default: current directory);
                                   # the whole repository is still analyzed, so callers elsewhere count
  --base <ref>                     # required: the branch or commit to compare against, e.g. origin/main
  --markdown                       # the same report as a table, for a pull request comment
  --json                           # machine-readable, with each function's callers; also carries the Markdown
  --out <file>                     # write to a file instead of stdout
  --fail-on <checks>               # exit 1 if the change adds any of: security, complexity, unused, dependencies
  --max-files <n>                  # cap files analyzed (default: 100000)
```

Exit codes are distinct so CI can tell a finding from a failure: `0` the review ran and no `--fail-on`
check found anything, `1` a `--fail-on` check found something, `2` the review could not run (for
example, not a git repository, or `--base` is not a commit this checkout has). A shallow CI checkout
needs the base branch fetched before it can compare against it.

To run it on pull requests, a GitHub Action wraps this command:
[vishalkelur28-cyber/archsetu-action](https://github.com/vishalkelur28-cyber/archsetu-action), used as
`uses: vishalkelur28-cyber/archsetu-action@v1`.

---

## `share`: turn a project into a page you can send someone

```bash
npx -y @archsetuweb/cli@latest share
```

Run it inside a project folder. It measures the project, reads its README for a sentence about what it
does and its `origin` remote for a link to the code, prints both so you can see what is about to be
published, and finishes by printing a public URL: `your-project.archsetu.com`.

No account, no file to find, nothing to upload, and no prompts: everything is a flag with a working
default. Progress goes to stderr and only the finished URL goes to stdout, so `share > url.txt` works.

| Flag | What it does |
|---|---|
| `--about "what it does"` | Your own words instead of the README paragraph. `--no-readme` publishes none. |
| `--demo <url>` / `--video <url>` / `--writeup <url>` | Links shown on the page. |
| `--repo <url>` | The code link, if your git remote is wrong or missing. |
| `--highlight "..."` | Something worth reading. Repeat for up to six. |
| `--name "Project Name"` / `--as my-project` | The title and the web address to claim. |

The page says what you built, what you built it with and how much of it there is. It carries no score and
no grade. Nothing on it is verified by ArchSetu, and it says so.

What is sent: file, line and function counts, the language breakdown, commit counts and dates, and the
description, stack and links printed before publishing. What is never sent: your source code, file paths,
security findings, and contributor names or email addresses. A token embedded in your git remote is
stripped before the remote is published.

---

## As a CLI

```bash
npx -y @archsetuweb/cli@latest analyze .          # full analysis
npx -y @archsetuweb/cli@latest analyze . --json   # machine-readable
npx -y @archsetuweb/cli@latest health .           # just the health score
npx -y @archsetuweb/cli@latest dead-code .        # unreachable functions
```

Other commands:

- `review --base <ref>`: what a change touches, for a pull request or before you commit (see above).
- `install-hook --min-score <n>`: a pre-commit hook that blocks a commit when the health score drops below `n`. `uninstall-hook` removes it.
- `init-ai-rules`: adds an ArchSetu block to your AI assistant's instructions file (Claude Code, Cursor, Copilot).
- `submit <owner/repo> [dir]`: analyze locally and submit the result to archsetu.com, for repositories too large for the hosted analyzer.

---

## What it will not tell you

Worth reading before you trust a number. Each tool repeats the relevant limit in its own results, so an agent sees it at the point of use.

- **It reads code, it does not run it.** Nothing is executed, no tests are run, no coverage is measured. "Untested" means no test reaches the function through the static call graph, which is not the same as uncovered.
- **The call graph cannot see dynamic calls.** Reflection, dynamic dispatch, dependency injection, callbacks passed by name and calls from outside the repository are invisible. So dead code is a list of candidates to verify, and blast radius is a lower bound on real impact.
- **Calls resolve by function name.** Where two functions share a name, the graph attributes a call to one of them. Distrust a surprising result for a common name like `handle`, `run` or `init`.
- **Security findings are regex heuristics.** No AST, no taint analysis, no vulnerability database. Expect false positives in test fixtures and example config, and read the cited line before believing any of them.
- **Results are cached.** A full analysis takes seconds to minutes, so it is reused across calls. Every result says when it was computed and flags itself stale once the cache expires; pass `refresh` to force a fresh run.
- **Very large repositories are truncated.** The file walk is capped, and results say so explicitly rather than presenting a partial analysis as a complete one.

---

Full documentation: [archsetu.com/mcp](https://www.archsetu.com/mcp)

MIT licensed.
