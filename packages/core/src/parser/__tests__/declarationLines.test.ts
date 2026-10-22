import { describe, it, expect } from 'vitest';
import { parseFile } from '../ParserRegistry.js';
import type { ParsedFunction } from '../../types/parser.types.js';

function functions(source: string, filePath: string): ParsedFunction[] {
  const analysis = parseFile(source, filePath);
  if (!analysis) throw new Error(`no parser for ${filePath}`);
  return analysis.functions;
}

describe('declaration line numbers', () => {
  // Patterns starting with `^\s*` under the `m` flag could begin on the blank
  // line above a declaration, so every function after a blank line - nearly
  // all of them - was reported one or more lines early.
  it.each([
    ['/r/a.kt', 'fun a() {\n}\n\n\nfun b() {\n}\n', 5],
    ['/r/a.cs', 'class C {\n  public void A() {\n  }\n\n  public void B() {\n  }\n}\n', 5],
    ['/r/a.php', '<?php\nfunction a() {\n}\n\nfunction b() {\n}\n', 5],
    ['/r/a.swift', 'func a() {\n}\n\nfunc b() {\n}\n', 4],
    ['/r/a.dart', 'void a() {\n}\n\nvoid b() {\n}\n', 4],
    ['/r/a.scala', 'object O {\n  def a() = {\n  }\n\n  def b() = {\n  }\n}\n', 5],
    ['/r/a.groovy', 'def a() {\n}\n\ndef b() {\n}\n', 4],
    ['/r/a.sol', 'contract C {\n  function a() public {\n  }\n\n  function b() public {\n  }\n}\n', 5],
  ] as const)('%s reports the second function on line %i', (filePath, source, expected) => {
    const second = functions(source, filePath).find((f) => f.name.toLowerCase() === 'b');
    expect(second?.startLine).toBe(expected);
  });
});

describe('C# parser', () => {
  it('starts a method on its own line when an attribute sits above it', () => {
    const works = functions('public class T\n{\n    [Fact]\n    public void Works()\n    {\n    }\n}\n', '/r/T.cs').find((f) => f.name === 'Works');
    expect(works?.startLine).toBe(4);
  });

  it('parses a generic return type containing a comma', () => {
    const names = functions('class T {\n  public Dictionary<string, int> Counts() {\n    return null;\n  }\n}\n', '/r/T.cs').map((f) => f.name);
    expect(names).toContain('Counts');
  });

  it('does not take an Allman-style else-if or an object initializer for a method', () => {
    const names = functions(
      'class T {\n  void A() {\n    if (x)\n    {\n    }\n    else if (y)\n    {\n    }\n    return new Widget(x)\n    {\n      Size = 1\n    };\n  }\n}\n',
      '/r/T.cs',
    ).map((f) => f.name);
    expect(names).not.toContain('if');
    expect(names).not.toContain('Widget');
  });
});
