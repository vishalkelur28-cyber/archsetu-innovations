/**
 * Tests for the part of `archsetu share` that decides what a project IS.
 *
 * These matter more than most tests in this repo, because every other way of
 * finding a bug here is unavailable. There is no type error in reading the
 * wrong paragraph out of a README, no lint rule that notices a GitHub token
 * surviving into a published URL, and no server-side validation that can tell a
 * badge row from a description. The failure mode is a page that looks fine and
 * says the wrong thing about somebody's work - which is exactly the class of
 * bug that reached real users last time.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectAbout, detectStack, normalizeRemoteUrl, readmeDescription } from '../projectAbout.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archsetu-about-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const writeFile = (name: string, content: string): void => {
  const target = path.join(dir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};

describe('readmeDescription', () => {
  it('returns empty when there is no readme', () => {
    expect(readmeDescription(dir)).toBe('');
  });

  it('skips the title and takes the first real paragraph', () => {
    writeFile(
      'README.md',
      [
        '# Library Management System',
        '',
        'A web app that lets a college library issue books, track due dates and',
        'fine late returns.',
        '',
        '## Setup',
        '',
        'Run npm install first.',
      ].join('\n'),
    );

    expect(readmeDescription(dir)).toBe(
      'A web app that lets a college library issue books, track due dates and fine late returns.',
    );
  });

  /**
   * The single most common README shape on GitHub, and the one that made this
   * function necessary rather than a one-line "take the first paragraph". A
   * centred logo, a wall of shield badges and a table of contents all sit above
   * the only sentence that describes the project.
   */
  it('walks past centred HTML, badges and a table of contents', () => {
    writeFile(
      'README.md',
      [
        '<p align="center">',
        '  <img src="logo.png" width="200" />',
        '</p>',
        '',
        '<h1 align="center">BandNameGenerator</h1>',
        '',
        '[![build](https://img.shields.io/badge/build-passing-green)](https://ci.example.com)',
        '[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)',
        '',
        '- [Install](#install)',
        '- [Usage](#usage)',
        '',
        'Generates a band name from two words you type, as a small Python script.',
      ].join('\n'),
    );

    expect(readmeDescription(dir)).toBe(
      'Generates a band name from two words you type, as a small Python script.',
    );
  });

  it('never returns the contents of a code fence', () => {
    writeFile(
      'README.md',
      [
        '# Thing',
        '',
        '```bash',
        'pip install -r requirements.txt && python main.py --flag',
        '```',
        '',
        'An image classifier for handwritten digits, trained on MNIST.',
      ].join('\n'),
    );

    const described = readmeDescription(dir);
    expect(described).toBe('An image classifier for handwritten digits, trained on MNIST.');
    expect(described).not.toContain('pip install');
  });

  it('strips markdown so no punctuation is published as prose', () => {
    writeFile(
      'README.md',
      '**Chhap** is a tool that turns a [project](https://example.com) into a `page`.\n',
    );

    expect(readmeDescription(dir)).toBe('Chhap is a tool that turns a project into a page.');
  });

  /**
   * A one-word or fragment description looks worse on a page than no
   * description, because the page has a fallback sentence built from the
   * measurements and that reads like English.
   */
  it('refuses a fragment too short to be a description', () => {
    writeFile('README.md', '# Project\n\nTODO\n');
    expect(readmeDescription(dir)).toBe('');
  });

  it('finds a readme whatever it is called', () => {
    writeFile('ReadMe.markdown', 'A command line tool for renaming large batches of photo files.\n');
    expect(readmeDescription(dir)).toContain('renaming large batches');
  });

  it('caps the length and ends on a whole word', () => {
    writeFile('README.md', `# T\n\n${'alpha '.repeat(200)}\n`);
    const described = readmeDescription(dir);

    expect(described.length).toBeLessThanOrEqual(300);
    expect(described).not.toMatch(/alph\.\.\.$/);
  });

  it('removes invisible characters the server would reject', () => {
    writeFile('README.md', '# T\n\nA tool for\u200btracking\u202e expenses across several accounts.\n');
    const described = readmeDescription(dir);

    expect(described).not.toMatch(/[\u200b\u202e]/);
    expect(described).toContain('tracking');
  });
});

describe('normalizeRemoteUrl', () => {
  it('converts the ssh form git actually stores', () => {
    expect(normalizeRemoteUrl('git@github.com:00PRASAD/BandNameGeneratorProject.git')).toBe(
      'https://github.com/00PRASAD/BandNameGeneratorProject',
    );
  });

  it('handles the ssh:// scheme and drops the trailing .git', () => {
    expect(normalizeRemoteUrl('ssh://git@gitlab.com/group/project.git')).toBe(
      'https://gitlab.com/group/project',
    );
  });

  /**
   * The reason this function strips rather than just validates.
   *
   * `git clone` writes a remote in this shape whenever a credential helper is
   * not configured, and plenty of tutorials tell people to paste exactly this.
   * Publishing it would put a live GitHub token on a public page belonging to a
   * student who does not know it is in there.
   */
  it('strips credentials embedded in the remote', () => {
    const out = normalizeRemoteUrl('https://ghp_AAAABBBBCCCCDDDDEEEE@github.com/someone/project.git');

    expect(out).toBe('https://github.com/someone/project');
    expect(out).not.toContain('ghp_');
  });

  it('refuses anything that is not a remote a stranger can open', () => {
    expect(normalizeRemoteUrl('')).toBe('');
    expect(normalizeRemoteUrl('/home/me/projects/thing')).toBe('');
    expect(normalizeRemoteUrl('C:\\Users\\me\\project')).toBe('');
    expect(normalizeRemoteUrl('javascript:alert(1)')).toBe('');
    expect(normalizeRemoteUrl('https://localhost/project.git')).toBe('');
  });
});

describe('detectStack', () => {
  it('puts the language first and recognises npm dependencies', () => {
    writeFile(
      'package.json',
      JSON.stringify({ dependencies: { react: '^18.0.0', express: '^4.0.0', '@types/node': '^20' } }),
    );

    const stack = detectStack(dir, 'TypeScript');

    expect(stack[0]).toBe('TypeScript');
    expect(stack).toContain('React');
    expect(stack).toContain('Express');
    // Not every dependency, only the ones a reader recognises. A page listing
    // @types/node tells nobody anything and crowds out the names that matter.
    expect(stack.join(' ')).not.toContain('types');
  });

  it('reads a python requirements file, specifiers and extras included', () => {
    writeFile('requirements.txt', ['flask==2.3.2', 'uvicorn[standard]>=0.20', 'pandas', '# a comment'].join('\n'));

    const stack = detectStack(dir, 'Python');

    expect(stack).toContain('Flask');
    expect(stack).toContain('Uvicorn');
    expect(stack).toContain('pandas');
  });

  /**
   * The whole reason detection goes by manifest rather than through the
   * engine's `declaredDependencies`, which only covers npm, PyPI and Go. Java,
   * Rust, PHP, Ruby, Dart and C++ students are a large share of the audience
   * and would otherwise get no stack at all.
   */
  it('works for ecosystems the engine does not parse', () => {
    writeFile(
      'pom.xml',
      '<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>',
    );

    const stack = detectStack(dir, 'Java');

    expect(stack).toContain('Maven');
    expect(stack).toContain('Spring Boot');
  });

  it('recognises a technology from a file existing at all', () => {
    writeFile('Dockerfile', 'FROM node:20\n');
    writeFile('Cargo.toml', '[dependencies]\naxum = "0.7"\n');

    const stack = detectStack(dir, 'Rust');

    expect(stack).toContain('Docker');
    expect(stack).toContain('Cargo');
    expect(stack).toContain('Axum');
  });

  /**
   * Found by publishing a real one: a hand written three-page photography site
   * has no package.json, no requirements.txt and no manifest of any kind, so
   * the entire row was a single chip reading "CSS". A front-end project with no
   * build step is one of the commonest shapes of student work there is.
   */
  it('names the other languages when there is no manifest to read', () => {
    const stack = detectStack(dir, 'css', { css: 54, html: 29, javascript: 16 });

    expect(stack).toEqual(['CSS', 'HTML', 'JavaScript']);
  });

  it('leaves out file formats nobody calls a stack', () => {
    const stack = detectStack(dir, 'python', { python: 60, json: 20, yaml: 15, markdown: 5 });

    expect(stack).toEqual(['Python']);
  });

  it('ignores a language that is a rounding error of the codebase', () => {
    const stack = detectStack(dir, 'java', { java: 95, shell: 5 });

    expect(stack).toEqual(['Java']);
  });

  /**
   * Order is not cosmetic: the preview card shows the first three chips, and
   * "Python · Flask · pytest" tells a reader more about a web app than
   * "Python · HTML" does. The HTML chip still appears, just later.
   */
  it('puts frameworks ahead of secondary languages', () => {
    writeFile('requirements.txt', 'Flask==3.0.0\npytest==7.4.4\n');

    const stack = detectStack(dir, 'python', { python: 81, html: 19 });

    expect(stack.slice(0, 3)).toEqual(['Python', 'Flask', 'pytest']);
    expect(stack).toContain('HTML');
  });

  it('never repeats a chip and never exceeds the cap', () => {
    writeFile(
      'package.json',
      JSON.stringify({
        dependencies: { react: '^18', 'react-dom': '^18', next: '^15' },
        devDependencies: { react: '^18', typescript: '^5' },
      }),
    );

    const stack = detectStack(dir, 'TypeScript');

    expect(new Set(stack).size).toBe(stack.length);
    expect(stack.length).toBeLessThanOrEqual(12);
    // react and react-dom are both React, and the chip appears once.
    expect(stack.filter((s) => s === 'React')).toHaveLength(1);
  });

  it('survives a manifest that does not parse', () => {
    writeFile('package.json', '{ "dependencies": { "react": ');
    expect(() => detectStack(dir, 'JavaScript')).not.toThrow();
    expect(detectStack(dir, 'JavaScript')).toEqual(['JavaScript']);
  });
});

describe('collectAbout', () => {
  it('lets a flag beat the README', () => {
    writeFile('README.md', '# T\n\nThe paragraph that is in the readme file right now.\n');

    const about = collectAbout(dir, 'python', {}, { about: 'What I actually want it to say.' });

    expect(about.text).toBe('What I actually want it to say.');
  });

  /** `--about ""` is how somebody deliberately publishes no description. */
  it('treats an explicitly empty description as a choice', () => {
    writeFile('README.md', '# T\n\nA paragraph that would otherwise be used as the description.\n');
    expect(collectAbout(dir, 'python', {}, { about: '' }).text).toBe('');
  });

  it('honours --no-readme', () => {
    writeFile('README.md', '# T\n\nA paragraph that would otherwise be used as the description.\n');
    expect(collectAbout(dir, 'python', {}, { readme: false }).text).toBe('');
  });

  it('drops a link it cannot publish rather than failing', () => {
    const about = collectAbout(dir, 'python', {}, {
      repo: 'not-a-url',
      demo: 'https://demo.example.com/app',
    });

    expect(about.links.map((l) => l.kind)).toEqual(['demo']);
  });

  it('keeps highlights inside the limits the server enforces', () => {
    const about = collectAbout(dir, 'python', {}, {
      highlights: ['one', '', '   ', 'two', 'three', 'four', 'five', 'six', 'seven'],
    });

    expect(about.highlights).toEqual(['one', 'two', 'three', 'four', 'five', 'six']);
  });
});
