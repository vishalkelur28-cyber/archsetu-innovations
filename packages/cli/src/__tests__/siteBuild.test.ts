/**
 * Tests for the code that decides what kind of project a student is standing
 * in, and therefore what they get.
 *
 * Getting this wrong is not a cosmetic failure in either direction. Calling a
 * Flask project a website publishes its `static/` folder and hands somebody a
 * link to the wrong half of their work. Calling a React project a server tells
 * them to wait for a feature they do not need. Neither mistake announces
 * itself, and neither is visible to a type checker.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectSite,
  detectPackageManager,
  detectProject,
  findBrokenAbsoluteLinks,
  findOutputDir,
  needsServer,
  type WebProject,
} from '../siteBuild.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archsetu-site-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, content: string): void => {
  const target = path.join(dir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};

const pkg = (value: Record<string, unknown>): void =>
  write('package.json', JSON.stringify(value, null, 2));

const asWeb = (detection: ReturnType<typeof detectProject>): WebProject => {
  if (detection === null || needsServer(detection)) throw new Error('expected a web project');
  return detection;
};

describe('detectProject: things that need a server', () => {
  it('knows Flask, Django and FastAPI from the requirements file', () => {
    for (const [requirement, framework] of [
      ['Flask==3.0.0', 'Flask'],
      ['Django>=5.0', 'Django'],
      ['fastapi', 'FastAPI'],
      ['streamlit==1.30', 'Streamlit'],
    ]) {
      fs.rmSync(path.join(dir, 'requirements.txt'), { force: true });
      write('requirements.txt', `${requirement}\n`);

      const detection = detectProject(dir);
      expect(needsServer(detection), requirement).toBe(true);
      if (needsServer(detection)) expect(detection.framework).toBe(framework);
    }
  });

  it('knows Express even though the project is full of JavaScript', () => {
    pkg({ dependencies: { express: '^4.19.2' }, scripts: { build: 'echo hi' } });
    write('public/index.html', '<h1>static</h1>');

    const detection = detectProject(dir);
    expect(needsServer(detection)).toBe(true);
  });

  /**
   * Next.js is two products behind one name. Without `output: "export"` the
   * same code needs a Node process, and publishing its build folder would
   * hand somebody an app whose every data-loading page is broken.
   */
  it('separates the two kinds of Next.js project', () => {
    pkg({ dependencies: { next: '^15.0.0' }, scripts: { build: 'next build' } });
    write('next.config.js', 'module.exports = { reactStrictMode: true };\n');
    expect(needsServer(detectProject(dir))).toBe(true);

    write('next.config.js', "module.exports = { output: 'export' };\n");
    const exported = detectProject(dir);
    expect(needsServer(exported)).toBe(false);
    expect(asWeb(exported).outDirCandidates).toContain('out');
  });

  it('treats a Rust binary and Rust for the browser differently', () => {
    write('Cargo.toml', '[package]\nname = "cli-tool"\n\n[dependencies]\nclap = "4"\n');
    expect(needsServer(detectProject(dir))).toBe(true);

    write('Cargo.toml', '[package]\nname = "app"\n\n[dependencies]\nyew = "0.21"\n');
    expect(needsServer(detectProject(dir))).toBe(false);
  });

  it('knows a Java project is not a folder of files', () => {
    write('pom.xml', '<project></project>');
    const detection = detectProject(dir);
    expect(needsServer(detection)).toBe(true);
    if (needsServer(detection)) expect(detection.framework).toBe('Java');
  });
});

describe('detectProject: things that build into a website', () => {
  it('recognises Vite and names the framework inside it', () => {
    pkg({
      dependencies: { react: '^18', 'react-dom': '^18' },
      devDependencies: { vite: '^5' },
      scripts: { build: 'vite build' },
    });

    const project = asWeb(detectProject(dir));
    expect(project.kind).toBe('vite');
    expect(project.framework).toBe('React');
    expect(project.outDirCandidates).toContain('dist');
    expect(project.buildScript).toBe('build');
  });

  it('recognises Create React App, Angular, Astro and SvelteKit', () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ dependencies: { 'react-scripts': '^5' } }, 'cra', 'build'],
      [{ dependencies: { '@angular/core': '^18' } }, 'angular', 'dist'],
      [{ dependencies: { astro: '^4' } }, 'astro', 'dist'],
      [{ dependencies: { '@sveltejs/kit': '^2' } }, 'sveltekit', 'build'],
    ];

    for (const [dependencies, kind, outDir] of cases) {
      pkg({ ...dependencies, scripts: { build: 'x' } });
      const project = asWeb(detectProject(dir));
      expect(project.kind, kind).toBe(kind);
      expect(project.outDirCandidates, kind).toContain(outDir);
    }
  });

  it('publishes a hand written site with no build step at all', () => {
    write('index.html', '<h1>hello</h1>');
    write('style.css', 'body{}');

    const project = asWeb(detectProject(dir));
    expect(project.kind).toBe('static');
    expect(project.buildScript).toBeNull();
  });

  /**
   * A folder with both an index.html and a build script is a source project,
   * not a finished site. Publishing the source index.html would serve a page
   * referencing `/src/main.jsx`, which no browser can run.
   */
  it('builds rather than publishing the source index.html', () => {
    pkg({ devDependencies: { vite: '^5' }, scripts: { build: 'vite build' } });
    write('index.html', '<script type="module" src="/src/main.jsx"></script>');

    expect(asWeb(detectProject(dir)).buildScript).toBe('build');
  });

  it('finds nothing in a folder that is neither', () => {
    write('notes.txt', 'hello');
    expect(detectProject(dir)).toBeNull();
  });
});

describe('detectPackageManager', () => {
  it('uses whichever lockfile is there', () => {
    expect(detectPackageManager(dir)).toBe('npm');
    write('pnpm-lock.yaml', '');
    expect(detectPackageManager(dir)).toBe('pnpm');
  });
});

describe('findOutputDir', () => {
  /**
   * Angular is why this searches instead of trusting a name: recent versions
   * write dist/<project>/browser, older ones dist/<project>, and the project
   * name comes from their own config.
   */
  it('finds the entry point however deeply the build nested it', () => {
    write('dist/my-app/browser/index.html', '<h1>built</h1>');
    expect(findOutputDir(dir, ['dist'])).toBe(path.join(dir, 'dist', 'my-app', 'browser'));
  });

  it('returns null when the build produced nothing', () => {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    expect(findOutputDir(dir, ['dist'])).toBeNull();
  });
});

describe('collectSite', () => {
  it('collects a build and leaves out what must not be published', () => {
    write('out/index.html', '<h1>hi</h1>');
    write('out/assets/app.js', 'console.log(1)');
    write('out/.env', 'SECRET=hunter2');
    write('out/installer.exe', 'MZ');
    write('out/node_modules/pkg/index.js', 'module.exports={}');

    const collected = collectSite(path.join(dir, 'out'), 'vite');
    if ('error' in collected) throw new Error(collected.error.join(' '));

    expect(collected.files.map((f) => f.path).sort()).toEqual(['assets/app.js', 'index.html']);
    expect(collected.skipped).toContain('.env');
    expect(collected.skipped).toContain('installer.exe');
  });

  it('refuses a folder with no entry point', () => {
    write('out/assets/app.js', 'x');
    const collected = collectSite(path.join(dir, 'out'), 'vite');
    expect('error' in collected && collected.error[0]).toContain('no index.html');
  });

  /**
   * One HTML file means the browser is routing and unknown paths have to
   * answer with the app; several means the build wrote a real page each and
   * they must not.
   */
  it('works out single page routing from what the build produced', () => {
    write('spa/index.html', '<div id="root"></div>');
    expect((collectSite(path.join(dir, 'spa'), 'vite') as { spa: boolean }).spa).toBe(true);

    write('ssg/index.html', '<h1>home</h1>');
    write('ssg/about.html', '<h1>about</h1>');
    expect((collectSite(path.join(dir, 'ssg'), 'next-export') as { spa: boolean }).spa).toBe(false);
  });

  it('never treats a hand written site as an app', () => {
    write('site/index.html', '<h1>only page</h1>');
    expect((collectSite(path.join(dir, 'site'), 'static') as { spa: boolean }).spa).toBe(false);
  });
});

describe('findBrokenAbsoluteLinks', () => {
  /**
   * The failure this exists to stop is total and silent: a project configured
   * for GitHub Pages asks for /repo-name/assets/index.js, which is not there
   * at the root of a domain, so the page loads and renders nothing at all.
   */
  it('catches a build configured for a subfolder', () => {
    write('out/index.html', '<script src="/my-repo/assets/index.js"></script>');
    write('out/assets/index.js', 'x');

    const files = [{ path: 'assets/index.js', absolutePath: '', bytes: 1 }];
    expect(findBrokenAbsoluteLinks(path.join(dir, 'out'), files)).toEqual(['my-repo/assets/index.js']);
  });

  it('is quiet when the links resolve', () => {
    write('out/index.html', '<script src="/assets/index.js"></script><link href="/assets/a.css">');
    const files = [
      { path: 'assets/index.js', absolutePath: '', bytes: 1 },
      { path: 'assets/a.css', absolutePath: '', bytes: 1 },
    ];
    expect(findBrokenAbsoluteLinks(path.join(dir, 'out'), files)).toEqual([]);
  });

  /** A missing favicon is untidy. A missing script is a white screen. */
  it('ignores anything that would not blank the page', () => {
    write('out/index.html', '<link rel="icon" href="/favicon.ico">');
    expect(findBrokenAbsoluteLinks(path.join(dir, 'out'), [])).toEqual([]);
  });
});
