import { describe, it, expect } from 'vitest';
import { parseFile } from '../ParserRegistry.js';
import { VueParser } from '../VueParser.js';
import { SvelteParser } from '../SvelteParser.js';
import { ProtobufParser } from '../ProtobufParser.js';
import { GraphQLParser } from '../GraphQLParser.js';
import { BatchParser } from '../BatchParser.js';

describe('VueParser', () => {
  // Vue 3 <script setup> style - plain top-level function declarations,
  // not the Options API's `methods: { greet() {} }` object-literal method
  // shorthand, which JsTsParser doesn't recognize as a function at all
  // (a separate, pre-existing gap in JsTsParser unrelated to Vue support).
  // <script setup> is also the more representative modern idiom.
  const src = `<template>
  <div>{{ message }}</div>
</template>

<script setup>
import { helper } from './utils'

function greet() {
  return helper()
}
</script>

<style scoped>
div { color: red; }
</style>
`;

  it('extracts functions from the <script> block via JsTsParser delegation', () => {
    const result = VueParser.parseFile(src, 'Component.vue');
    expect(result.language).toBe('vue');
    expect(result.functions.map((f) => f.name)).toContain('greet');
    expect(result.imports).toContainEqual({ source: './utils', symbols: ['helper'], isRelative: true });
  });

  it('shifts function line numbers by the <script> block offset in the real file', () => {
    const result = VueParser.parseFile(src, 'Component.vue');
    const greet = result.functions.find((f) => f.name === 'greet');
    // <script setup> opens on line 5 - "function greet()" is on line 8 of
    // the real file, not line 3 as JsTsParser's own internal 1-based
    // numbering for the isolated fragment would report it.
    expect(greet?.startLine).toBeGreaterThan(5);
  });

  it('detects <script lang="ts"> and parses as TypeScript', () => {
    const tsSrc = `<script lang="ts">
export function add(a: number, b: number): number {
  return a + b
}
</script>
`;
    const result = VueParser.parseFile(tsSrc, 'Add.vue');
    expect(result.functions.map((f) => f.name)).toContain('add');
  });

  it('returns an empty analysis for a component with no <script> block', () => {
    const result = VueParser.parseFile('<template><div>static</div></template>', 'Static.vue');
    expect(result.functions).toEqual([]);
  });
});

describe('SvelteParser', () => {
  const src = `<script>
  let count = 0;
  function increment() {
    count += 1;
  }
</script>

<button on:click={increment}>{count}</button>
`;

  it('extracts functions from the <script> block via JsTsParser delegation', () => {
    const result = SvelteParser.parseFile(src, 'Counter.svelte');
    expect(result.language).toBe('svelte');
    expect(result.functions.map((f) => f.name)).toContain('increment');
  });
});

describe('ProtobufParser', () => {
  const src = `syntax = "proto3";
import "common.proto";

message User {
  string name = 1;
}

service UserService {
  rpc GetUser(GetUserRequest) returns (User);
  rpc ListUsers(Empty) returns (stream User);
}
`;

  it('extracts messages/services as classes and rpc methods as functions', () => {
    const result = ProtobufParser.parseFile(src, 'user.proto');
    expect(result.classes.map((c) => c.name)).toEqual(expect.arrayContaining(['User', 'UserService']));
    expect(result.functions.map((f) => f.name)).toEqual(expect.arrayContaining(['GetUser', 'ListUsers']));
  });

  it('captures the import statement', () => {
    const result = ProtobufParser.parseFile(src, 'user.proto');
    expect(result.imports).toContainEqual({ source: 'common.proto', symbols: [], isRelative: true });
  });
});

describe('GraphQLParser', () => {
  const src = `type Query {
  user(id: ID!): User
  users: [User!]!
}

type User {
  id: ID!
  name: String!
}
`;

  it('extracts type blocks as classes and resolver-shaped fields as functions', () => {
    const result = GraphQLParser.parseFile(src, 'schema.graphql');
    expect(result.classes.map((c) => c.name)).toEqual(expect.arrayContaining(['Query', 'User']));
    expect(result.functions.map((f) => f.name)).toContain('user');
  });

  it('does not treat a plain data field (no arguments) as a function', () => {
    const result = GraphQLParser.parseFile(src, 'schema.graphql');
    expect(result.functions.map((f) => f.name)).not.toContain('users');
    expect(result.functions.map((f) => f.name)).not.toContain('name');
  });

  it('parses the resolver field argument name', () => {
    const result = GraphQLParser.parseFile(src, 'schema.graphql');
    expect(result.functions.find((f) => f.name === 'user')?.parameters).toEqual(['id']);
  });
});

describe('BatchParser', () => {
  const src = `@echo off
call :Deploy
goto :eof

:Deploy
echo Deploying...
call :Build
goto :eof

:Build
echo Building...
goto :eof
`;

  it('extracts labels as functions, excluding the reserved :eof label', () => {
    const result = BatchParser.parseFile(src, 'deploy.bat');
    const names = result.functions.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['Deploy', 'Build']));
    expect(names).not.toContain('eof');
  });

  it('resolves a call to another label', () => {
    const result = BatchParser.parseFile(src, 'deploy.bat');
    expect(result.functions.find((f) => f.name === 'Deploy')?.calls).toContain('Build');
  });

  it('captures a call to another batch script as an import', () => {
    const result = BatchParser.parseFile('call setup.bat\n', 'run.bat');
    expect(result.imports).toContainEqual({ source: 'setup.bat', symbols: [], isRelative: true });
  });
});

describe('YAML minimal scan (no functions, line-count only)', () => {
  it('is detected and counted, not left as unknown', () => {
    const result = parseFile('name: CI\non: [push]\n', '.github/workflows/ci.yml');
    expect(result?.language).toBe('yaml');
    expect(result?.functions).toEqual([]);
    expect(result?.lineCount).toBe(3);
  });
});
