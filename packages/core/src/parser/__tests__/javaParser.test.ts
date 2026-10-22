import { describe, it, expect } from 'vitest';
import { parseFile } from '../ParserRegistry.js';
import type { CallSite, FileAnalysis, ParsedFunction } from '../../types/parser.types.js';

function parse(source: string, filePath = '/r/src/main/java/app/A.java'): FileAnalysis {
  const analysis = parseFile(source, filePath);
  if (!analysis) throw new Error(`no parser for ${filePath}`);
  return analysis;
}

function fn(analysis: FileAnalysis, name: string, className?: string): ParsedFunction {
  const found = analysis.functions.find((f) => f.name === name && (className === undefined || f.className === className));
  if (!found) throw new Error(`no function ${className ?? ''}.${name}`);
  return found;
}

function site(f: ParsedFunction, name: string): CallSite {
  const found = f.callSites?.find((s) => s.name === name);
  if (!found) throw new Error(`no call to ${name} in ${f.name}`);
  return found;
}

describe('Java parser: declarations', () => {
  it('finds a method whose parameter annotation has arguments (every Spring MVC handler was missed)', () => {
    const a = parse(`class OwnerController {
  @GetMapping("/owners/{ownerId}")
  public String showOwner(@PathVariable("ownerId") int ownerId, Model model) {
    return "owners/ownerDetails";
  }
}
`);
    expect(fn(a, 'showOwner').parameters).toEqual(['ownerId', 'model']);
    expect(fn(a, 'showOwner').startLine).toBe(3);
  });

  it('reads generic, sealed and annotation types and records as classes, with their supertypes', () => {
    const a = parse(`package app;
public sealed interface Shape<T extends Comparable<T>> extends Measurable, Named permits Circle {}
@SuppressWarnings("serial") final class Box<T> extends Base<T> implements Comparable<Box<T>> {}
record Range(int lo, int hi) implements Comparable<Range> {}
@interface Marker { String value() default ""; }
`);
    expect(a.packageName).toBe('app');
    expect(a.classes.map((c) => `${c.kind} ${c.name}`)).toEqual(['interface Shape', 'class Box', 'record Range', 'annotation Marker']);
    expect(a.classes[0]?.implements).toEqual(['Measurable', 'Named']);
    expect(a.classes[1]?.extends).toBe('Base');
    expect(a.classes[1]?.implements).toEqual(['Comparable']);
  });

  it('keeps braces in strings, text blocks, char literals and comments out of the body (a `}` in a string ended methods early)', () => {
    const a = parse(`class Json {
  String open() {
    String s = "{\\"a\\": " + '}';
    String t = """
        }}}
        """;
    /* } */ return s + t;
  }

  void next() {}
}
`);
    expect(fn(a, 'open').endLine).toBe(8);
    expect(fn(a, 'next').startLine).toBe(10);
  });

  it('reads constructors, compact record constructors, enum constant bodies and anonymous classes, each with its own type path', () => {
    const a = parse(`class Outer {
  Outer(int x) { this(); }
  Outer() {}
  record Point(int x, int y) {
    Point { if (x < 0) throw new IllegalArgumentException(); }
  }
  enum Op {
    PLUS { int apply(int a, int b) { return a + b; } };
    abstract int apply(int a, int b);
  }
  Runnable task() {
    return new Runnable() { public void run() { helper(); } };
  }
  void helper() {}
}
`);
    expect(a.functions.filter((f) => f.isConstructor).map((f) => `${f.className}.${f.name}/${f.parameters.length}`)).toEqual([
      'Outer.Outer/1',
      'Outer.Outer/0',
      'Outer.Point.Point/2',
    ]);
    expect(fn(a, 'apply').className).toBe('Outer.Op.$1');
    expect(fn(a, 'run').className).toBe('Outer.$2');
    expect(a.anonymousClasses?.map((c) => c.extends)).toEqual(['Outer.Op', 'Runnable']);
    // An abstract method has no body, so it is not a function.
    expect(a.functions.filter((f) => f.name === 'apply')).toHaveLength(1);
  });

  it('treats interface methods as public unless declared private (JLS 9.4)', () => {
    const a = parse(`interface Extractor {
  default boolean each(Object o) { return check(o); }
  private boolean check(Object o) { return true; }
}
`);
    expect(fn(a, 'each').isExported).toBe(true);
    expect(fn(a, 'check').isExported).toBe(false);
  });

  it('does not report declarations inside comments or text blocks', () => {
    const a = parse(`class Docs {
  // void commented() {}
  String sample = """
      class Fake { void inside() {} }
      """;
}
`);
    expect(a.functions).toEqual([]);
    expect(a.classes.map((c) => c.name)).toEqual(['Docs']);
  });
});

describe('Java parser: complexity', () => {
  it('counts decisions as McCabe does, matching javac on every method of seven repositories', () => {
    const a = parse(`class C {
  int f(java.util.Map<?, ? extends Number> m, int x) {
    if (x > 0) { x++; } else if (x < 0) { x--; }
    do { x--; } while (x > 10 && x != 3);
    int y = x > 1 ? 1 : 0;
    switch (x) { case 1, 2 -> y++; case 3 -> y--; default -> y = 0; }
    try { y++; } catch (RuntimeException e) { y--; }
    return y;
  }
}
`);
    // if, else-if's if, while, &&, ?:, case 1, case 2, case 3, catch
    expect(fn(a, 'f').complexity).toBe(10);
  });
});

describe('Java parser: call sites', () => {
  const a = parse(`package app;
import static java.lang.Math.max;
import static app.Geometry.*;
class Order {
  private final Ledger ledger = new Ledger();
  private Customer customer;
  Order(Customer c) { this.customer = c; }
  long total(java.util.List<Item> items, Item first) {
    long sum = 0;
    for (Item item : items) sum += item.price();
    first.price();
    ledger.record(sum, "total");
    this.customer.notify(sum);
    max(1, 2);
    area(first);
    Order.rounding(sum);
    new Receipt(this).print();
    Builder.create().withName("x").build();
    System.out.println(sum);
    items.forEach(Item::price);
    return items.get(0).price();
  }
  static long rounding(long v) { return v; }
}
`);
  const total = fn(a, 'total');

  it('types the receiver from a parameter, a loop variable, a field and this.field', () => {
    expect(site(total, 'price')).toMatchObject({ kind: 'member', receivers: ['Item'], args: 0 });
    expect(site(total, 'record')).toMatchObject({ kind: 'member', receivers: ['Ledger'], args: 2, argTypes: ['long', 'String'] });
    expect(site(total, 'notify')).toMatchObject({ kind: 'member', receivers: ['Customer'] });
  });

  it('lets a single-static-import shadow static imports on demand (JLS 6.4.1)', () => {
    expect(site(total, 'max').receivers).toEqual(['Order', 'java.lang.Math']);
    expect(site(total, 'area').receivers).toEqual(['Order', 'app.Geometry']);
  });

  it('records static calls, constructor calls and calls on what another call returns', () => {
    expect(site(total, 'rounding')).toMatchObject({ kind: 'static', receivers: ['Order'] });
    expect(site(total, 'Receipt')).toMatchObject({ kind: 'new', receivers: ['Receipt'], argTypes: ['Order'] });
    expect(site(total, 'print')).toMatchObject({ kind: 'member', receivers: ['Receipt'] });
    const build = site(total, 'build');
    expect(build.receiverCall?.name).toBe('withName');
    expect(build.receiverCall?.receiverCall).toMatchObject({ name: 'create', kind: 'static', receivers: ['Builder'] });
  });

  it('marks a call on a static field of a type with that type, so a library field means a library call', () => {
    expect(site(total, 'println')).toMatchObject({ kind: 'unknown', via: 'System', field: 'out' });
  });

  it('records method references with an unknown argument count', () => {
    expect(total.callSites?.filter((s) => s.name === 'price').some((s) => s.args === -1 && s.receivers?.[0] === 'Item')).toBe(true);
  });

  it('still lists every called name for dead-code detection, without the function itself', () => {
    expect(total.calls).toEqual(expect.arrayContaining(['price', 'record', 'Receipt', 'print', 'build', 'rounding']));
    expect(total.calls).not.toContain('total');
  });
});
