import { describe, it, expect } from 'vitest';
import { LuaParser } from '../LuaParser.js';
import { PerlParser } from '../PerlParser.js';
import { HaskellParser } from '../HaskellParser.js';
import { ElixirParser } from '../ElixirParser.js';
import { ObjectiveCParser } from '../ObjectiveCParser.js';

describe('LuaParser', () => {
  const src = `
local function helper(x)
  return x + 1
end

local M = {}

function M.new(name)
  return { name = name }
end

function M:greet()
  print("hi " .. self.name)
end

require("socket")

return M
`;

  it('extracts functions with correct export/local visibility', () => {
    const result = LuaParser.parseFile(src, 'mymodule.lua');
    expect(result.language).toBe('lua');
    const names = result.functions.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['helper', 'M.new', 'M:greet']));

    const helper = result.functions.find((f) => f.name === 'helper');
    expect(helper?.isExported).toBe(false);

    const ctor = result.functions.find((f) => f.name === 'M.new');
    expect(ctor?.isExported).toBe(true);
  });

  it('implicitly adds self as the first parameter for colon methods', () => {
    const result = LuaParser.parseFile(src, 'mymodule.lua');
    const method = result.functions.find((f) => f.name === 'M:greet');
    expect(method?.parameters).toEqual(['self']);
  });

  it('captures require() calls as imports', () => {
    const result = LuaParser.parseFile(src, 'mymodule.lua');
    expect(result.imports).toContainEqual({ source: 'socket', symbols: [], isRelative: false });
  });
});

describe('PerlParser', () => {
  const src = `
package MyApp::Helper;

use strict;
use warnings;
use List::Util qw(sum);

sub add {
    my ($a, $b) = @_;
    return $a + $b;
}

sub _private {
    return 1;
}

1;
`;

  it('extracts subs, skipping pragma "use" statements', () => {
    const result = PerlParser.parseFile(src, 'Helper.pm');
    expect(result.language).toBe('perl');
    const names = result.functions.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['add', '_private']));
    expect(result.imports.map((i) => i.source)).toEqual(['List::Util']);
  });

  it('parses parameter names out of the my (...) = @_ idiom', () => {
    const result = PerlParser.parseFile(src, 'Helper.pm');
    const add = result.functions.find((f) => f.name === 'add');
    expect(add?.parameters).toEqual(['$a', '$b']);
  });

  it('treats leading-underscore subs as unexported', () => {
    const result = PerlParser.parseFile(src, 'Helper.pm');
    const priv = result.functions.find((f) => f.name === '_private');
    expect(priv?.isExported).toBe(false);
  });

  it('records the package name as an export', () => {
    const result = PerlParser.parseFile(src, 'Helper.pm');
    expect(result.exports).toContain('MyApp::Helper');
  });
});

describe('HaskellParser', () => {
  const src = `
module MyMath (add, factorial) where

import Data.List (sort)
import qualified Data.Map as Map

add :: Int -> Int -> Int
add x y = x + y

factorial :: Int -> Int
factorial 0 = 1
factorial n = n * factorial (n - 1)

data Shape = Circle Double | Square Double
`;

  it('extracts functions and merges consecutive equations for the same name', () => {
    const result = HaskellParser.parseFile(src, 'MyMath.hs');
    expect(result.language).toBe('haskell');
    const names = result.functions.map((f) => f.name);
    expect(names).toEqual(['add', 'factorial']);
  });

  it('captures imports and the module name', () => {
    const result = HaskellParser.parseFile(src, 'MyMath.hs');
    expect(result.imports.map((i) => i.source)).toEqual(['Data.List', 'Data.Map']);
    expect(result.exports).toContain('MyMath');
  });

  it('models a data declaration as a class', () => {
    const result = HaskellParser.parseFile(src, 'MyMath.hs');
    expect(result.classes.map((c) => c.name)).toContain('Shape');
  });
});

describe('ElixirParser', () => {
  const src = `
defmodule MyApp.Greeter do
  import String

  def hello(name) do
    IO.puts(greet(name))
  end

  defp greet(name) do
    "Hello, " <> name
  end
end
`;

  it('extracts the module as a class and functions with def/defp visibility', () => {
    const result = ElixirParser.parseFile(src, 'greeter.ex');
    expect(result.language).toBe('elixir');
    expect(result.classes.map((c) => c.name)).toContain('MyApp.Greeter');

    const hello = result.functions.find((f) => f.name === 'hello');
    const greet = result.functions.find((f) => f.name === 'greet');
    expect(hello?.isExported).toBe(true);
    expect(greet?.isExported).toBe(false);
  });

  it('captures import statements', () => {
    const result = ElixirParser.parseFile(src, 'greeter.ex');
    expect(result.imports.map((i) => i.source)).toContain('String');
  });
});

describe('ObjectiveCParser', () => {
  const src = `
#import "Person.h"
#import <Foundation/Foundation.h>

@interface Person : NSObject
- (void)greet;
@end

@implementation Person

- (void)greet {
    NSLog(@"hi");
    [self logDetails];
}

+ (instancetype)sharedInstance {
    return nil;
}

@end
`;

  it('extracts @interface/@implementation as classes and methods with bodies as functions', () => {
    const result = ObjectiveCParser.parseFile(src, 'Person.m');
    expect(result.language).toBe('objectivec');
    expect(result.classes.map((c) => c.name)).toEqual(['Person', 'Person']);

    const names = result.functions.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['greet', 'sharedInstance']));
  });

  it('distinguishes quoted (relative) vs angle-bracket (framework) imports', () => {
    const result = ObjectiveCParser.parseFile(src, 'Person.m');
    expect(result.imports).toContainEqual({ source: 'Person.h', symbols: [], isRelative: true });
    expect(result.imports).toContainEqual({ source: 'Foundation/Foundation.h', symbols: [], isRelative: false });
  });

  it('extracts message-send calls from method bodies', () => {
    const result = ObjectiveCParser.parseFile(src, 'Person.m');
    const greet = result.functions.find((f) => f.name === 'greet');
    expect(greet?.calls).toContain('logDetails');
  });
});
