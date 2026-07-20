import { describe, it, expect } from 'vitest';
import { parseFile } from '../ParserRegistry.js';
import { ZigParser } from '../ZigParser.js';
import { SolidityParser } from '../SolidityParser.js';
import { PowerShellParser } from '../PowerShellParser.js';
import { GroovyParser } from '../GroovyParser.js';
import { OCamlParser } from '../OCamlParser.js';
import { ErlangParser } from '../ErlangParser.js';
import { ClojureParser } from '../ClojureParser.js';
import { FSharpParser } from '../FSharpParser.js';
import { JuliaParser } from '../JuliaParser.js';
import { NimParser } from '../NimParser.js';
import { CrystalParser } from '../CrystalParser.js';
import { VimScriptParser } from '../VimScriptParser.js';
import { EmacsLispParser } from '../EmacsLispParser.js';
import { MakefileParser } from '../MakefileParser.js';
import { DockerfileParser } from '../DockerfileParser.js';
import { TerraformParser } from '../TerraformParser.js';
import { SqlParser } from '../SqlParser.js';

describe('ZigParser', () => {
  const src = `const std = @import("std");

fn helper() void {}

pub fn add(a: i32, b: i32) i32 {
    helper();
    return a + b;
}

pub const Point = struct {
    x: f32,
    y: f32,
};
`;

  it('extracts functions with pub visibility and captures imports/structs', () => {
    const result = ZigParser.parseFile(src, 'main.zig');
    const names = result.functions.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['helper', 'add']));
    expect(result.functions.find((f) => f.name === 'add')?.isExported).toBe(true);
    expect(result.functions.find((f) => f.name === 'helper')?.isExported).toBe(false);
    expect(result.imports).toContainEqual({ source: 'std', symbols: [], isRelative: false });
    expect(result.classes.map((c) => c.name)).toContain('Point');
  });

  it('recognizes a call to a same-file function', () => {
    const result = ZigParser.parseFile(src, 'main.zig');
    expect(result.functions.find((f) => f.name === 'add')?.calls).toContain('helper');
  });
});

describe('SolidityParser', () => {
  const src = `import "./Token.sol";

contract MyToken {
    function transfer(address to, uint256 amount) public returns (bool) {
        return checkBalance(amount);
    }

    function checkBalance(uint256 amount) private returns (bool) {
        return true;
    }
}
`;

  it('extracts the contract as a class and functions with visibility-based export', () => {
    const result = SolidityParser.parseFile(src, 'Token.sol');
    expect(result.classes.map((c) => c.name)).toContain('MyToken');
    const transfer = result.functions.find((f) => f.name === 'transfer');
    const checkBalance = result.functions.find((f) => f.name === 'checkBalance');
    expect(transfer?.isExported).toBe(true);
    expect(checkBalance?.isExported).toBe(false);
    expect(transfer?.calls).toContain('checkBalance');
  });

  it('captures the import path', () => {
    const result = SolidityParser.parseFile(src, 'Token.sol');
    expect(result.imports).toContainEqual({ source: './Token.sol', symbols: [], isRelative: true });
  });
});

describe('PowerShellParser', () => {
  const src = `Import-Module MyModule

function Deploy-App {
    param($Name)
    Write-Host $Name
}
`;

  it('extracts a hyphenated Verb-Noun function name', () => {
    const result = PowerShellParser.parseFile(src, 'deploy.ps1');
    expect(result.functions.map((f) => f.name)).toContain('Deploy-App');
  });

  it('captures Import-Module as an import', () => {
    const result = PowerShellParser.parseFile(src, 'deploy.ps1');
    expect(result.imports).toContainEqual({ source: 'MyModule', symbols: [], isRelative: false });
  });

  it('parses parameters declared via a param() block inside the body', () => {
    const result = PowerShellParser.parseFile(src, 'deploy.ps1');
    expect(result.functions[0]?.parameters).toEqual(['Name']);
  });
});

describe('GroovyParser', () => {
  const src = `import org.example.Foo

class MyClass {
    def myMethod(String name) {
        return greet(name)
    }

    private def greet(String name) {
        return "hi " + name
    }
}
`;

  it('extracts the class and methods with private-based export', () => {
    const result = GroovyParser.parseFile(src, 'MyClass.groovy');
    expect(result.classes.map((c) => c.name)).toContain('MyClass');
    const myMethod = result.functions.find((f) => f.name === 'myMethod');
    const greet = result.functions.find((f) => f.name === 'greet');
    expect(myMethod?.isExported).toBe(true);
    expect(greet?.isExported).toBe(false);
    expect(myMethod?.calls).toContain('greet');
  });

  it('captures the import statement', () => {
    const result = GroovyParser.parseFile(src, 'MyClass.groovy');
    expect(result.imports).toContainEqual({ source: 'org.example.Foo', symbols: [], isRelative: false });
  });
});

describe('OCamlParser', () => {
  // Top-level bindings must sit at true column 0 - OCamlParser (like
  // HaskellParser) uses extractIndentedBody, which treats any leading
  // whitespace as real nested-code indentation.
  const src = `open List

let add x y = x + y

let square x =
  x * x

module Point = struct
  let origin = 0
end
`;

  it('extracts top-level let bindings as functions', () => {
    const result = OCamlParser.parseFile(src, 'lib.ml');
    expect(result.functions.map((f) => f.name)).toEqual(expect.arrayContaining(['add', 'square']));
  });

  it('captures open statements as imports and modules as classes', () => {
    const result = OCamlParser.parseFile(src, 'lib.ml');
    expect(result.imports).toContainEqual({ source: 'List', symbols: [], isRelative: false });
    expect(result.classes.map((c) => c.name)).toContain('Point');
  });

  it('does not swallow a later binding into an earlier multi-line match (regression guard)', () => {
    // The exact bug class HaskellParser hit: a greedy `\s+` in the args
    // group would let a single match span both `add` and `square`, and
    // `square`'s own equation would then never be matched at all - each
    // must be recognized as its own separate, correctly-scoped function.
    const result = OCamlParser.parseFile(src, 'lib.ml');
    const add = result.functions.find((f) => f.name === 'add');
    const square = result.functions.find((f) => f.name === 'square');
    expect(add?.parameters).toEqual(['x', 'y']);
    expect(square?.parameters).toEqual(['x']);
    expect(add?.startLine).not.toBe(square?.startLine);
  });
});

describe('FSharpParser', () => {
  const src = `open System

let add x y = x + y

module Utils =
  let helper = 0
`;

  it('extracts top-level let bindings and open/module statements', () => {
    const result = FSharpParser.parseFile(src, 'lib.fs');
    expect(result.functions.map((f) => f.name)).toContain('add');
    expect(result.imports).toContainEqual({ source: 'System', symbols: [], isRelative: false });
    expect(result.classes.map((c) => c.name)).toContain('Utils');
  });
});

describe('ErlangParser', () => {
  const src = `-module(mymodule).
-export([add/2, helper/0]).

add(A, B) ->
    helper(),
    A + B.

helper() ->
    ok.
`;

  it('extracts functions and merges multi-clause definitions without duplication', () => {
    const result = ErlangParser.parseFile(src, 'mymodule.erl');
    const names = result.functions.map((f) => f.name);
    expect(names.filter((n) => n === 'add')).toHaveLength(1);
    expect(names.filter((n) => n === 'helper')).toHaveLength(1);
  });

  it('marks -export()-listed functions as exported', () => {
    const result = ErlangParser.parseFile(src, 'mymodule.erl');
    expect(result.functions.find((f) => f.name === 'add')?.isExported).toBe(true);
  });

  it('resolves a call to another function in the same module', () => {
    const result = ErlangParser.parseFile(src, 'mymodule.erl');
    expect(result.functions.find((f) => f.name === 'add')?.calls).toContain('helper');
  });

  it('handles multi-clause pattern-matching functions as one entry', () => {
    const multiClause = `factorial(0) -> 1;
factorial(N) -> N * factorial(N - 1).
`;
    const result = ErlangParser.parseFile(multiClause, 'fact.erl');
    expect(result.functions.filter((f) => f.name === 'factorial')).toHaveLength(1);
  });
});

describe('ClojureParser', () => {
  const src = `(ns myapp.core
  (:require [clojure.string :as str]))

(defn greet [name]
  (str "Hello, " (helper name)))

(defn- helper [name]
  name)
`;

  it('extracts defn/defn- with correct export visibility', () => {
    const result = ClojureParser.parseFile(src, 'core.clj');
    const greet = result.functions.find((f) => f.name === 'greet');
    const helper = result.functions.find((f) => f.name === 'helper');
    expect(greet?.isExported).toBe(true);
    expect(helper?.isExported).toBe(false);
    expect(greet?.calls).toContain('helper');
  });

  it('captures the namespace and require', () => {
    const result = ClojureParser.parseFile(src, 'core.clj');
    expect(result.exports).toContain('myapp.core');
    expect(result.imports).toContainEqual({ source: 'clojure.string', symbols: [], isRelative: false });
  });
});

describe('EmacsLispParser', () => {
  const src = `(require 'cl-lib)

(defun greet (name)
  (message "Hello, %s" (helper name)))

(defun helper (name)
  name)
`;

  it('extracts defun functions and their parameter lists', () => {
    const result = EmacsLispParser.parseFile(src, 'init.el');
    expect(result.functions.map((f) => f.name)).toEqual(expect.arrayContaining(['greet', 'helper']));
    expect(result.functions.find((f) => f.name === 'greet')?.parameters).toEqual(['name']);
  });

  it('captures require statements as imports', () => {
    const result = EmacsLispParser.parseFile(src, 'init.el');
    expect(result.imports).toContainEqual({ source: 'cl-lib', symbols: [], isRelative: false });
  });

  it('resolves a call to another function', () => {
    const result = EmacsLispParser.parseFile(src, 'init.el');
    expect(result.functions.find((f) => f.name === 'greet')?.calls).toContain('helper');
  });
});

describe('VimScriptParser', () => {
  const src = `function! Greet(name)
  call s:LocalHelper()
  echo "Hello " . a:name
endfunction

function! s:LocalHelper()
endfunction
`;

  it('extracts functions with script-local (s:) visibility', () => {
    const result = VimScriptParser.parseFile(src, 'plugin.vim');
    const greet = result.functions.find((f) => f.name === 'Greet');
    const local = result.functions.find((f) => f.name === 'LocalHelper');
    expect(greet?.isExported).toBe(true);
    expect(local?.isExported).toBe(false);
  });

  it('resolves a call to a script-local function', () => {
    const result = VimScriptParser.parseFile(src, 'plugin.vim');
    expect(result.functions.find((f) => f.name === 'Greet')?.calls).toContain('LocalHelper');
  });
});

describe('JuliaParser', () => {
  const src = `using LinearAlgebra

function add(x, y)
    return helper(x, y)
end

function helper(x, y)
    return x + y
end

module MyModule
end
`;

  it('extracts functions and marks top-level ones exported', () => {
    const result = JuliaParser.parseFile(src, 'lib.jl');
    expect(result.functions.map((f) => f.name)).toEqual(expect.arrayContaining(['add', 'helper']));
    expect(result.functions.every((f) => f.isExported)).toBe(true);
  });

  it('captures using statements and modules', () => {
    const result = JuliaParser.parseFile(src, 'lib.jl');
    expect(result.imports).toContainEqual({ source: 'LinearAlgebra', symbols: [], isRelative: false });
    expect(result.classes.map((c) => c.name)).toContain('MyModule');
  });

  it('resolves a call to another top-level function', () => {
    const result = JuliaParser.parseFile(src, 'lib.jl');
    expect(result.functions.find((f) => f.name === 'add')?.calls).toContain('helper');
  });

  it('extracts the real function name from a module-qualified method extension (function Module.name(...))', () => {
    // Real bug found analyzing FluxML/Flux.jl: `function ChainRulesCore.rrule(...)`
    // extends a function *owned by another package* (Julia's standard
    // multiple-dispatch interop pattern) - without stripping the module
    // qualifier, this was captured as a function literally named
    // "ChainRulesCore", not the function actually being defined, "rrule".
    const qualifiedSrc = `function ChainRulesCore.rrule(x)
    return x
end
`;
    const result = JuliaParser.parseFile(qualifiedSrc, 'ext.jl');
    expect(result.functions.map((f) => f.name)).toEqual(['rrule']);
    expect(result.functions.map((f) => f.name)).not.toContain('ChainRulesCore');
  });
});

describe('NimParser', () => {
  const src = `import strutils

proc add*(a, b: int): int =
  return a + b

proc helper(a: int): int =
  return a
`;

  it('marks only the star-exported proc as exported', () => {
    const result = NimParser.parseFile(src, 'lib.nim');
    const add = result.functions.find((f) => f.name === 'add');
    const helper = result.functions.find((f) => f.name === 'helper');
    expect(add?.isExported).toBe(true);
    expect(helper?.isExported).toBe(false);
  });

  it('captures the import statement', () => {
    const result = NimParser.parseFile(src, 'lib.nim');
    expect(result.imports).toContainEqual({ source: 'strutils', symbols: [], isRelative: false });
  });
});

describe('CrystalParser', () => {
  const src = `require "json"

class Point
  def initialize(@x : Int32, @y : Int32)
  end

  def to_s
    helper
  end

  private def helper
    "point"
  end
end
`;

  it('extracts the class and its methods', () => {
    const result = CrystalParser.parseFile(src, 'point.cr');
    expect(result.classes.map((c) => c.name)).toContain('Point');
    expect(result.functions.map((f) => f.name)).toEqual(expect.arrayContaining(['initialize', 'to_s', 'helper']));
  });

  it('captures the require statement', () => {
    const result = CrystalParser.parseFile(src, 'point.cr');
    expect(result.imports).toContainEqual({ source: 'json', symbols: [], isRelative: false });
  });
});

describe('MakefileParser', () => {
  const src = `build: clean
\tgo build -o bin/app .

clean:
\trm -rf bin/

include common.mk
`;

  it('extracts targets as functions with their dependencies as parameters', () => {
    const result = parseFile(src, 'Makefile');
    expect(result?.language).toBe('makefile');
    const names = result?.functions.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['build', 'clean']));
    expect(result?.functions.find((f) => f.name === 'build')?.parameters).toEqual(['clean']);
  });

  it('does not mistake a variable assignment for a target', () => {
    const withVar = `CC := gcc

build:
\t$(CC) main.c
`;
    const result = MakefileParser.parseFile(withVar, 'Makefile');
    expect(result.functions.map((f) => f.name)).not.toContain('CC');
    expect(result.functions.map((f) => f.name)).toContain('build');
  });

  it('captures include statements as imports', () => {
    const result = MakefileParser.parseFile(src, 'Makefile');
    expect(result.imports).toContainEqual({ source: 'common.mk', symbols: [], isRelative: true });
  });

  it('is detected by bare filename with no extension', () => {
    const result = parseFile('build:\n\techo hi\n', 'Makefile');
    expect(result?.language).toBe('makefile');
  });
});

describe('DockerfileParser', () => {
  const src = `FROM node:20 AS builder
WORKDIR /app
COPY . .
RUN npm install

FROM node:20
COPY --from=builder /app/dist ./dist
CMD ["node", "index.js"]
`;

  it('extracts each build stage as a class', () => {
    const result = DockerfileParser.parseFile(src, 'Dockerfile');
    expect(result.classes.map((c) => c.name)).toContain('builder');
    expect(result.classes.length).toBe(2);
  });

  it('captures the base image and cross-stage COPY as imports', () => {
    const result = DockerfileParser.parseFile(src, 'Dockerfile');
    expect(result.imports.some((i) => i.source === 'node:20')).toBe(true);
    expect(result.imports).toContainEqual({ source: 'builder', symbols: [], isRelative: true });
  });

  it('is detected by bare filename with no extension', () => {
    const result = parseFile('FROM alpine\n', 'Dockerfile');
    expect(result?.language).toBe('dockerfile');
  });

  it('handles a --platform flag and a hyphenated stage name (real bug found analyzing docker/getting-started)', () => {
    // `FROM --platform=$BUILDPLATFORM node:18-alpine AS app-base` - without
    // skipping the --platform=... flag, `--platform=$BUILDPLATFORM` itself
    // was captured as if it were the image name, which also broke the "AS
    // name" match entirely (it no longer immediately followed the image
    // token) - and separately, `(\w+)` for the stage name doesn't include
    // hyphens, silently truncating "app-base" to "app".
    const platformSrc = `FROM --platform=$BUILDPLATFORM node:18-alpine AS app-base
RUN npm install
`;
    const result = DockerfileParser.parseFile(platformSrc, 'Dockerfile');
    expect(result.classes).toHaveLength(1);
    expect(result.classes[0]?.name).toBe('app-base');
    expect(result.classes[0]?.extends).toBe('node:18-alpine');
    expect(result.imports).toContainEqual({ source: 'node:18-alpine', symbols: [], isRelative: false });
  });
});

describe('TerraformParser', () => {
  const src = `resource "aws_instance" "web" {
  ami = "ami-123"
}

module "vpc" {
  source = "./modules/vpc"
}
`;

  it('extracts resource and module blocks as classes', () => {
    const result = TerraformParser.parseFile(src, 'main.tf');
    expect(result.classes.map((c) => c.name)).toEqual(expect.arrayContaining(['aws_instance.web', 'vpc']));
  });

  it('captures a module source as an import', () => {
    const result = TerraformParser.parseFile(src, 'main.tf');
    expect(result.imports).toContainEqual({ source: './modules/vpc', symbols: [], isRelative: true });
  });
});

describe('SqlParser', () => {
  const src = `CREATE TABLE users (
  id INT PRIMARY KEY,
  name VARCHAR(255)
);

CREATE FUNCTION get_user_name(uid INT) RETURNS VARCHAR AS $$
BEGIN
  RETURN uid;
END;
$$ LANGUAGE plpgsql;
`;

  it('extracts a table as a class and a function/procedure as a function', () => {
    const result = SqlParser.parseFile(src, 'schema.sql');
    expect(result.classes.map((c) => c.name)).toContain('users');
    expect(result.functions.map((f) => f.name)).toContain('get_user_name');
  });

  it('parses the function parameter name', () => {
    const result = SqlParser.parseFile(src, 'schema.sql');
    expect(result.functions.find((f) => f.name === 'get_user_name')?.parameters).toEqual(['uid']);
  });
});
