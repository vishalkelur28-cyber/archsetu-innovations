import path from 'path';
import type { ParsedFunction, SupportedLanguage } from '../types/parser.types.js';
import type { CallGraphNode, RepoAnalysis, RiskLevel, SecurityFinding } from '../types/analysis.types.js';
import { parseFile } from '../parser/ParserRegistry.js';
import { complexityLevel } from '../parser/BaseParser.js';
import { isTestFile } from '../utils/fileUtils.js';
import { classifyBlastRadiusRisk } from './BlastRadiusAnalyzer.js';

/**
 * Answers a reviewer's question about one change - a pull request, or work
 * not yet pushed - rather than about the whole repository: which functions
 * did it touch, what depends on them, and what did it add that deserves a
 * look. Everything here is read off an analysis of the changed tree plus the
 * changed files' base versions; nothing is reported about code the change
 * did not touch, so old debt never shows up as the author's problem.
 *
 * Pure: the caller supplies the diff and the base contents (the CLI gets
 * them from git), so this has no git or filesystem dependency of its own.
 */

/** 1-indexed, inclusive. */
export interface LineRange {
  start: number;
  end: number;
}

export interface ChangedFile {
  /** Absolute path of the file as it is now, in the same form analyzeRepo reports. */
  filePath: string;
  /** Absolute path the file had at the base, or null when the change adds it. Differs from filePath only for a rename. */
  baseFilePath: string | null;
  /** Lines of the current file the change added or rewrote. */
  changedLines: LineRange[];
  /**
   * Lines of the current file after which the change only deleted lines. A
   * function counts as changed by a deletion when it spans both that line and
   * the next one - a deletion at its edge is between functions, not in one.
   */
  deletedAfter?: number[];
  /** The file's content at the base, or null when it did not exist there. */
  baseContent: string | null;
  /**
   * The file's content now. When given, same-named functions - overloads,
   * methods of different classes - are paired with their base versions by
   * parameter list first, so one inserted between others does not shift the
   * pairing of every one after it.
   */
  content?: string;
}

export interface ReviewOptions {
  /**
   * Findings to match against the changed lines instead of the analysis's own.
   * The whole-repository scan stops at 500 findings, so a repository with that
   * much old debt would hide whatever a change adds; the CLI scans the changed
   * files on their own and passes the result here.
   */
  securityFindings?: readonly SecurityFinding[];
}

export interface ChangedFunction {
  name: string;
  filePath: string;
  language: SupportedLanguage;
  startLine: number;
  endLine: number;
  change: 'added' | 'modified';
  complexity: number;
  /** Complexity at the base, or null for an added function. */
  baseComplexity: number | null;
  isExported: boolean;
  /** Functions that call this one directly. */
  directCallers: number;
  directCallerFiles: number;
  /** The direct callers themselves, by file and line, at most CALLER_LIST_LIMIT - so every count can be checked. */
  callers: CallerRef[];
  /** Functions that reach this one within REACH_DEPTH calls, direct callers included. */
  affectedFunctions: number;
  affectedFiles: number;
  affectedEntryPoints: number;
  /** The search stopped at REACH_LIMIT functions; the real reach is larger. */
  reachCapped: boolean;
  riskLevel: RiskLevel;
  /**
   * Other functions in the repository declared with the same name. Calls are
   * matched by name, so their callers may be counted as this function's too.
   */
  sameNameElsewhere: number;
  /**
   * The name is also a standard-library method (see STANDARD_METHOD_NAMES), so
   * only callers in its own file are counted.
   */
  standardMethodName: boolean;
}

export interface CallerRef {
  name: string;
  filePath: string;
  startLine: number;
}

export interface NewUndeclaredImport {
  packageName: string;
  filePaths: string[];
}

export interface ChangeReview {
  changedFiles: number;
  testFilesChanged: number;
  /** Changed functions outside test files, widest reach first. */
  changedFunctions: ChangedFunction[];
  /** Findings on lines the change added or rewrote. */
  securityFindings: SecurityFinding[];
  /** Changed functions that are now at critical complexity and were added or got more complex. */
  complexityIncreases: ChangedFunction[];
  /** Added functions that are not exported and that nothing calls. */
  unusedNewFunctions: ChangedFunction[];
  /** Packages a changed file now imports, that its base version did not, and that no manifest declares. */
  newUndeclaredImports: NewUndeclaredImport[];
  /** The analysis stopped at its file limit, so some files - changed ones included - were not parsed. */
  analysisTruncated: boolean;
  /** The stored call graph was capped, so some changed functions or callers may be missing. */
  callGraphTruncated: boolean;
}

/** How many calls deep reach is followed - the same bound as BlastRadiusAnalyzer, so a function's risk reads the same here as on its report page. */
export const REACH_DEPTH = 3;

/**
 * Where the reach search stops. Risk is already at its highest past 30
 * functions, and a hub in a large, densely connected repository can reach
 * tens of thousands - which, for every function a big change touched, took
 * minutes.
 */
export const REACH_LIMIT = 1000;

/** How many direct callers are listed by name; the count stays exact beyond it. */
export const CALLER_LIST_LIMIT = 100;

/**
 * Method names the standard libraries already use, on maps, arrays, strings,
 * promises, streams, responses and the like. A call written `x.get(` names
 * no receiver the call graph can see, so a repository's own `get` method was
 * credited with every `Map.get`, `headers.get` and `searchParams.get` in the
 * codebase - 148 callers in one hop, measured on this repository. For these
 * names only callers in the declaring file are counted; an under-count here
 * is disclosed on the report, an over-count would not be.
 */
const STANDARD_METHOD_NAMES = new Set([
  // Map, Set, Array, Object, iterators
  'get', 'set', 'has', 'add', 'delete', 'clear', 'keys', 'values', 'entries', 'forEach', 'map', 'filter',
  'find', 'findIndex', 'some', 'every', 'reduce', 'includes', 'indexOf', 'push', 'pop', 'shift', 'unshift',
  'slice', 'splice', 'concat', 'join', 'sort', 'reverse', 'flat', 'flatMap', 'fill', 'at', 'next',
  // String, RegExp, JSON, Function, Object
  'split', 'replace', 'replaceAll', 'match', 'matchAll', 'test', 'exec', 'trim', 'startsWith', 'endsWith',
  'toLowerCase', 'toUpperCase', 'substring', 'charAt', 'padStart', 'padEnd', 'parse', 'stringify',
  'toString', 'valueOf', 'toJSON', 'call', 'apply', 'bind', 'assign',
  // Promise, events, streams, HTTP, console
  'then', 'catch', 'finally', 'resolve', 'reject', 'all', 'race', 'on', 'once', 'off', 'emit',
  'addEventListener', 'removeEventListener', 'pipe', 'open', 'close', 'read', 'write', 'end', 'send',
  'json', 'text', 'status', 'log', 'info', 'warn', 'error', 'debug',
  // Python dict, list, str
  'append', 'extend', 'insert', 'remove', 'update', 'items', 'copy', 'count', 'index', 'format',
  'strip', 'lower', 'upper', 'encode', 'decode', 'startswith', 'endswith',
  // Go and Java interfaces
  'Close', 'Read', 'Write', 'String', 'Error', 'Len', 'equals', 'hashCode', 'size', 'isEmpty',
  'contains', 'put', 'stream', 'collect', 'of', 'iterator', 'compareTo',
]);

/**
 * Languages whose calls CallGraphBuilder links by the receiver's type (see
 * TypedCallResolver), so that an edge already names the one function a call
 * reaches. Their callers are read straight off the edges; the name-matching
 * guesses below are for languages linked by name alone.
 */
const TYPED_CALL_LANGUAGES: ReadonlySet<string> = new Set(['java']);

interface NodePlace {
  file: string;
  dir: string;
}

export function reviewChanges(
  analysis: RepoAnalysis,
  changes: readonly ChangedFile[],
  options: ReviewOptions = {},
): ChangeReview {
  const changeByKey = new Map(changes.map((c) => [pathKey(c.filePath), c]));
  const { nodes, edges } = analysis.callGraph;
  const isTest = (filePath: string) => isTestFile(`/${path.relative(analysis.rootDir, filePath)}`);

  // Path keys are worked out once per node: resolving them per edge visited
  // was most of the run time on a large change.
  const place = new Map<CallGraphNode, NodePlace>();
  const placeOf = (node: CallGraphNode): NodePlace => {
    let p = place.get(node);
    if (!p) {
      const file = pathKey(node.filePath);
      p = { file, dir: path.dirname(file) };
      place.set(node, p);
    }
    return p;
  };

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  // Indexed by the callee's name rather than its node id. CallGraphBuilder
  // resolves every call to one node per name (the last declared), so a
  // function sharing its name with another in a later file would otherwise
  // show no callers at all - an under-count presented as "low risk" is the
  // one mistake a reviewer cannot see past.
  const callersByName = new Map<string, CallGraphNode[]>();
  const callersById = new Map<string, CallGraphNode[]>();
  for (const edge of edges) {
    const target = nodeById.get(edge.target);
    const caller = nodeById.get(edge.source);
    if (!target || !caller) continue;
    const list = callersByName.get(target.name);
    if (list) list.push(caller);
    else callersByName.set(target.name, [caller]);
    const byId = callersById.get(target.id);
    if (byId) byId.push(caller);
    else callersById.set(target.id, [caller]);
  }

  const declarationsByName = new Map<string, number>();
  const filesByName = new Map<string, Set<string>>();
  const filesByNameAndDir = new Map<string, Set<string>>();
  const privateNamesByFile = new Map<string, Set<string>>();
  for (const node of nodes) {
    const { file, dir } = placeOf(node);
    declarationsByName.set(node.name, (declarationsByName.get(node.name) ?? 0) + 1);
    setFor(filesByName, node.name).add(file);
    setFor(filesByNameAndDir, `${node.name}\0${dir}`).add(file);
    if (!node.isExported) setFor(privateNamesByFile, file).add(node.name);
  }

  // Which files import which, where the import could be resolved (relative
  // JS/TS imports). The one way to tell which of several same-named exported
  // functions a call in another directory means.
  const importersOf = new Map<string, Set<string>>();
  for (const [file, importers] of Object.entries(analysis.changeImpactGraph)) {
    importersOf.set(pathKey(file), new Set(importers.map(pathKey)));
  }

  /**
   * Whether `caller` can be calling `callee`, beyond sharing a name with it.
   *
   * A parser's `calls` list holds every name a function mentions - calls, but
   * also values passed around, property accesses and JSX tags - because that
   * is what keeps dead-code detection from flagging used code. Matched by
   * name alone, `Math.round(` made a private `round` helper look called from
   * all over a repository, and an unqualified `.build()` matched every one of
   * ripgrep's 27 `build` methods, putting 38 callers behind one with 8. So a
   * caller in another file only counts where it could only mean this one:
   * - never, for a standard-library method name;
   * - never, when its own file declares a private function of that name - the
   *   one its bare call refers to;
   * - from the same directory, when no other file there declares the name
   *   (a Go package's functions; a method no sibling type also has - several
   *   in one directory are told apart only by a receiver's type, which a
   *   name-matched call graph cannot see);
   * - from further away only when the function is exported, and - if other
   *   files declare the same name - when the caller's file imports this one.
   * Where these leave out a real caller, the count is lower than the truth,
   * which the report says. They cannot keep out a call to a same-named
   * function from a library, or to an overload, so a count can also be
   * higher; the report says that too, and lists the callers so either can
   * be checked.
   */
  const canSee = (caller: CallGraphNode, callee: CallGraphNode): boolean => {
    const from = placeOf(caller);
    const to = placeOf(callee);
    if (from.file === to.file) return true;
    if (STANDARD_METHOD_NAMES.has(callee.name)) return false;
    if (privateNamesByFile.get(from.file)?.has(callee.name)) return false;
    const onlyOneInDir = (filesByNameAndDir.get(`${callee.name}\0${to.dir}`)?.size ?? 0) <= 1;
    if (from.dir === to.dir && onlyOneInDir) return true;
    // An import settles which of several same-named functions a call means.
    if (importersOf.get(to.file)?.has(from.file)) return callee.isExported;
    if (from.dir === to.dir || !callee.isExported) return false;
    return (filesByName.get(callee.name)?.size ?? 0) <= 1;
  };

  const visibleCallers = new Map<CallGraphNode, CallGraphNode[]>();
  const callersOf = (callee: CallGraphNode): CallGraphNode[] => {
    let list = visibleCallers.get(callee);
    if (!list) {
      list = TYPED_CALL_LANGUAGES.has(callee.language)
        ? (callersById.get(callee.id) ?? []).filter((c) => c !== callee)
        : (callersByName.get(callee.name) ?? []).filter((c) => c !== callee && canSee(c, callee));
      visibleCallers.set(callee, list);
    }
    return list;
  };

  const nodesByFile = new Map<string, CallGraphNode[]>();
  for (const node of nodes) {
    const key = placeOf(node).file;
    if (!changeByKey.has(key)) continue;
    const list = nodesByFile.get(key);
    if (list) list.push(node);
    else nodesByFile.set(key, [node]);
  }

  const safeToRemove = new Set(
    analysis.deadCode
      .filter((d) => d.isSafeToRemove)
      .map((d) => `${pathKey(d.function.filePath)}:${d.function.startLine}`),
  );

  const changedFunctions: ChangedFunction[] = [];
  const unusedNewFunctions: ChangedFunction[] = [];

  for (const change of changes) {
    if (isTest(change.filePath)) continue;
    const fileNodes = nodesByFile.get(pathKey(change.filePath)) ?? [];
    const touched = fileNodes.filter((n) => touches(change, n.startLine, endLineOf(n)));
    if (touched.length === 0) continue;

    const baseMatch = matchBaseFunctions(fileNodes, change);

    for (const node of touched) {
      const base = baseMatch.get(node) ?? null;
      const reach = reachOf(node, callersOf, placeOf);
      const fn: ChangedFunction = {
        name: node.name,
        filePath: node.filePath,
        language: node.language,
        startLine: node.startLine,
        endLine: endLineOf(node),
        change: base ? 'modified' : 'added',
        complexity: node.complexity,
        baseComplexity: base ? base.complexity : null,
        isExported: node.isExported,
        directCallers: reach.direct.length,
        directCallerFiles: new Set(reach.direct.map((n) => placeOf(n).file)).size,
        callers: [...reach.direct]
          .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine)
          .slice(0, CALLER_LIST_LIMIT)
          .map((n) => ({ name: n.name, filePath: n.filePath, startLine: n.startLine })),
        affectedFunctions: reach.functions,
        affectedFiles: reach.files,
        affectedEntryPoints: reach.entryPoints,
        reachCapped: reach.capped,
        riskLevel: classifyBlastRadiusRisk(reach.functions, reach.files),
        sameNameElsewhere: (declarationsByName.get(node.name) ?? 1) - 1,
        standardMethodName: STANDARD_METHOD_NAMES.has(node.name),
      };
      changedFunctions.push(fn);
      if (fn.change === 'added' && safeToRemove.has(`${placeOf(node).file}:${node.startLine}`)) {
        unusedNewFunctions.push(fn);
      }
    }
  }

  changedFunctions.sort((a, b) => b.affectedFunctions - a.affectedFunctions || b.complexity - a.complexity);

  const complexityIncreases = changedFunctions
    .filter((f) => complexityLevel(f.complexity) === 'critical' && (f.baseComplexity === null || f.complexity > f.baseComplexity))
    .sort((a, b) => b.complexity - a.complexity);

  const securityFindings = (options.securityFindings ?? analysis.securityRisk.findings).filter((finding) => {
    const change = changeByKey.get(pathKey(finding.filePath));
    return change !== undefined && change.changedLines.some((r) => r.start <= finding.line && r.end >= finding.line);
  });

  return {
    changedFiles: changes.length,
    testFilesChanged: changes.filter((c) => isTest(c.filePath)).length,
    changedFunctions,
    securityFindings,
    complexityIncreases,
    unusedNewFunctions,
    newUndeclaredImports: findNewUndeclaredImports(analysis, changeByKey),
    analysisTruncated: analysis.truncated,
    callGraphTruncated: analysis.detailTruncated,
  };
}

function endLineOf(node: CallGraphNode): number {
  return node.startLine + Math.max(node.lineCount, 1) - 1;
}

function touches(change: ChangedFile, start: number, end: number): boolean {
  return (
    change.changedLines.some((r) => r.start <= end && r.end >= start) ||
    (change.deletedAfter ?? []).some((line) => start <= line && end >= line + 1)
  );
}

/**
 * Pairs each current function with its base version: same name, same file,
 * matched in order of appearance so two same-named methods in one file pair
 * up first-to-first. A function with no base counterpart was added - which
 * includes one that was renamed, since by name it did not exist before.
 *
 * Keyed by the node itself, not its id: ids are `name@file`, so overloads and
 * same-named methods of different classes in one file share one, and a map
 * keyed by it gave every one of them the last one's base - ripgrep's
 * `from_low_args` read as complexity "6 -> 57" when it was 57 throughout.
 */
function matchBaseFunctions(fileNodes: readonly CallGraphNode[], change: ChangedFile): Map<CallGraphNode, ParsedFunction> {
  const matched = new Map<CallGraphNode, ParsedFunction>();
  if (change.baseContent === null || change.baseFilePath === null) return matched;
  const parsed = parseFile(change.baseContent, change.baseFilePath);
  if (!parsed) return matched;

  // Parameter lists of the current functions, which call-graph nodes don't carry.
  const currentParams = new Map<string, string>();
  if (change.content !== undefined) {
    for (const fn of parseFile(change.content, change.filePath)?.functions ?? []) {
      currentParams.set(`${fn.name}:${fn.startLine}`, fn.parameters.join(','));
    }
  }

  const baseByName = groupByName(parsed.functions);
  const currentByName = groupByName(fileNodes);
  for (const [name, current] of currentByName) {
    const base = baseByName.get(name) ?? [];
    const used = new Set<ParsedFunction>();
    // Overloads: the one base function with the same parameter list first.
    // Measured on commons-lang, where an `isAssignable` inserted between two
    // others made the next two read as each other's base by order alone.
    if (current.length > 1 || base.length > 1) {
      for (const node of current) {
        const params = currentParams.get(`${node.name}:${node.startLine}`);
        if (params === undefined) continue;
        const same = base.filter((b) => !used.has(b) && b.parameters.join(',') === params);
        if (same.length === 1) {
          matched.set(node, same[0]!);
          used.add(same[0]!);
        }
      }
    }
    const remainingBase = base.filter((b) => !used.has(b));
    current.filter((node) => !matched.has(node)).forEach((node, i) => {
      const counterpart = remainingBase[i];
      if (counterpart) matched.set(node, counterpart);
    });
  }
  return matched;
}

function groupByName<T extends { name: string; startLine: number }>(items: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(item.name);
    if (list) list.push(item);
    else groups.set(item.name, [item]);
  }
  for (const list of groups.values()) list.sort((a, b) => a.startLine - b.startLine);
  return groups;
}

interface Reach {
  direct: CallGraphNode[];
  functions: number;
  files: number;
  entryPoints: number;
  capped: boolean;
}

/** The functions that reach `target` within REACH_DEPTH calls, through callers it can see (see canSee). */
function reachOf(
  target: CallGraphNode,
  callersOf: (callee: CallGraphNode) => CallGraphNode[],
  placeOf: (node: CallGraphNode) => NodePlace,
): Reach {
  const visited = new Set<CallGraphNode>([target]);
  const affected: CallGraphNode[] = [];
  const direct: CallGraphNode[] = [];
  let frontier = [target];
  let capped = false;

  search: for (let depth = 1; depth <= REACH_DEPTH && frontier.length > 0; depth++) {
    const next: CallGraphNode[] = [];
    for (const callee of frontier) {
      for (const caller of callersOf(callee)) {
        if (visited.has(caller)) continue;
        if (affected.length >= REACH_LIMIT) {
          capped = true;
          break search;
        }
        visited.add(caller);
        affected.push(caller);
        if (depth === 1) direct.push(caller);
        next.push(caller);
      }
    }
    frontier = next;
  }

  return {
    direct,
    functions: affected.length,
    files: new Set(affected.map((n) => placeOf(n).file)).size,
    entryPoints: affected.filter((n) => n.isEntryPoint).length,
    capped,
  };
}

function findNewUndeclaredImports(
  analysis: RepoAnalysis,
  changeByKey: ReadonlyMap<string, ChangedFile>,
): NewUndeclaredImport[] {
  const baseImports = new Map<string, string[]>();
  const baseImportsOf = (change: ChangedFile): string[] => {
    const key = pathKey(change.filePath);
    let sources = baseImports.get(key);
    if (!sources) {
      sources = change.baseContent !== null && change.baseFilePath !== null
        ? (parseFile(change.baseContent, change.baseFilePath)?.imports ?? []).map((i) => i.source)
        : [];
      baseImports.set(key, sources);
    }
    return sources;
  };

  const result: NewUndeclaredImport[] = [];
  for (const { packageName, importedFrom } of analysis.dependencyHygiene.undeclaredImports) {
    const filePaths = importedFrom.filter((filePath) => {
      const change = changeByKey.get(pathKey(filePath));
      if (!change) return false;
      return !baseImportsOf(change).some((s) => s === packageName || s.startsWith(`${packageName}/`));
    });
    if (filePaths.length > 0) result.push({ packageName, filePaths });
  }
  return result;
}

function setFor<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

/** Git reports `D:/repo` where Node resolves `d:\repo`; both must name the same file. */
function pathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
