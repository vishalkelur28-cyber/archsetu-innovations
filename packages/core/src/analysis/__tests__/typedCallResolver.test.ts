import { describe, it, expect } from 'vitest';
import { parseFile } from '../../parser/ParserRegistry.js';
import { buildCallGraph } from '../CallGraphBuilder.js';
import type { FileAnalysis } from '../../types/parser.types.js';

/** Parses `files` (path -> source) and returns the call graph's edges as `Caller.method -> Callee.method/arity` strings. */
function edges(files: Record<string, string>): string[] {
  const analyses = Object.entries(files).map(([filePath, source]) => parseFile(source, filePath) as FileAnalysis);
  const label = new Map<string, string>();
  for (const a of analyses) {
    for (const f of a.functions) label.set(`${f.name}@${f.filePath}:${f.startLine}`, `${f.className}.${f.name}/${f.parameters.length}`);
  }
  const graph = buildCallGraph(analyses, '/r', []);
  return graph.edges.map((e) => `${label.get(e.source)} -> ${label.get(e.target)}`).sort();
}

const BUILDERS = {
  '/r/app/Request.java': `package app;
public class Request {
  public static class Builder {
    public Builder url(String u) { return this; }
    public Request build() { return new Request(); }
  }
}
`,
  '/r/app/Response.java': `package app;
public class Response {
  public static class Builder {
    public Response build() { return new Response(); }
  }
}
`,
};

describe('typed call resolution (Java)', () => {
  it('sends `builder.build()` to the receiver type only, not to every `build` in the repository', () => {
    const result = edges({
      ...BUILDERS,
      '/r/app/Client.java': `package app;
class Client {
  Request send(Request.Builder builder) {
    return builder.url("x").build();
  }
}
`,
    });
    expect(result).toEqual(['Client.send/1 -> Request.Builder.build/0', 'Client.send/1 -> Request.Builder.url/1']);
  });

  it('draws no edge for a call on a library type, even when the repository declares a method of that name', () => {
    const result = edges({
      '/r/app/Bag.java': `package app;
import java.util.List;
class Bag {
  void add(Object o) {}
  void fill(List<Object> items, Object o) {
    items.add(o);
    System.out.println(o);
  }
}
`,
      '/r/app/Printer.java': 'package app;\nclass Printer { void println(Object o) {} }\n',
    });
    expect(result).toEqual([]);
  });

  it('picks the overload the argument types fit (StringUtils.join-style overload families)', () => {
    const result = edges({
      '/r/app/Text.java': `package app;
class Text {
  static String join(int[] values, char sep) { return ""; }
  static String join(Object[] values, String sep) { return ""; }
  static String join(Iterable<?> values, String sep) { return ""; }
  String render(int[] numbers, String[] words) {
    return join(numbers, ',') + join(words, ", ") + join(java.util.List.of(), "-");
  }
}
`,
    });
    expect(result).toEqual([
      'Text.render/2 -> Text.join/2',
      'Text.render/2 -> Text.join/2',
      'Text.render/2 -> Text.join/2',
    ]);
    // ...and specifically the right three: one edge per overload, none twice.
    const analyses = [parseFile(`package app;
class Text {
  static String join(int[] values, char sep) { return ""; }
  static String join(Object[] values, String sep) { return ""; }
  String render(String[] words) { return join(words, ", "); }
}
`, '/r/app/Text.java') as FileAnalysis];
    const graph = buildCallGraph(analyses, '/r', []);
    expect(graph.edges.map((e) => e.target)).toEqual(['join@/r/app/Text.java:4']);
  });

  it('follows dispatch to the overrides in subtypes, across files', () => {
    const result = edges({
      '/r/app/Shape.java': 'package app;\npublic abstract class Shape { public abstract double area(); }\n',
      '/r/app/Circle.java': 'package app;\nclass Circle extends Shape { public double area() { return 3; } }\n',
      '/r/app/Square.java': 'package app;\nclass Square extends Shape { public double area() { return 4; } }\n',
      '/r/app/Report.java': `package app;
class Report {
  double total(java.util.List<Shape> shapes, Circle c) {
    double sum = c.area();
    for (Shape s : shapes) sum += s.area();
    return sum;
  }
}
`,
    });
    expect(result).toEqual(['Report.total/2 -> Circle.area/0', 'Report.total/2 -> Square.area/0']);
  });

  it('resolves a field inherited from a supertype in another file', () => {
    const result = edges({
      '/r/app/Ledger.java': 'package app;\nclass Ledger { void record(long v) {} }\n',
      '/r/app/Base.java': 'package app;\nclass Base { protected Ledger ledger; }\n',
      '/r/app/Shop.java': 'package app;\nclass Shop extends Base {\n  void sell() { ledger.record(1L); }\n}\n',
    });
    expect(result).toEqual(['Shop.sell/0 -> Ledger.record/1']);
  });

  it('resolves names through imports and packages, not by simple name alone', () => {
    const result = edges({
      '/r/a/Node.java': 'package a;\npublic class Node { public void visit() {} }\n',
      '/r/b/Node.java': 'package b;\npublic class Node { public void visit() {} }\n',
      '/r/c/Walker.java': 'package c;\nimport b.Node;\nclass Walker {\n  void walk(Node n) { n.visit(); }\n}\n',
    });
    expect(result).toEqual(['Walker.walk/1 -> Node.visit/0']);
    const analyses = [
      parseFile('package a;\npublic class Node { public void visit() {} }\n', '/r/a/Node.java') as FileAnalysis,
      parseFile('package b;\npublic class Node { public void visit() {} }\n', '/r/b/Node.java') as FileAnalysis,
      parseFile('package c;\nimport b.Node;\nclass Walker {\n  void walk(Node n) { n.visit(); }\n}\n', '/r/c/Walker.java') as FileAnalysis,
    ];
    expect(buildCallGraph(analyses, '/r', []).edges.map((e) => e.target)).toEqual(['visit@/r/b/Node.java:2']);
  });

  it('links an untyped call by name only when a single type declares the method', () => {
    const files = {
      '/r/app/Cache.java': 'package app;\nclass Cache { void evictAll() {} }\n',
      '/r/app/Job.java': 'package app;\nclass Job {\n  void run(Object registry) { lookup(registry).evictAll(); }\n  static native Object lookup(Object r);\n}\n',
    };
    expect(edges(files)).toEqual(['Job.run/1 -> Cache.evictAll/0']);
    expect(edges({ ...files, '/r/app/Pool.java': 'package app;\nclass Pool { void evictAll() {} }\n' })).toEqual([]);
  });
});
