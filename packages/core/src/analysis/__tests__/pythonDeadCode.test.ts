import { describe, it, expect } from 'vitest';
import { parseFile } from '../../parser/ParserRegistry.js';
import { findDeadCode } from '../DeadCodeFinder.js';
import type { FileAnalysis } from '../../types/parser.types.js';

function parsePy(source: string, filePath = '/fake/main.py'): FileAnalysis {
  const analysis = parseFile(source, filePath);
  if (!analysis) throw new Error('expected PythonParser to handle this fixture');
  return analysis;
}

describe('Python dead code detection - module-level (top-level) call visibility', () => {
  it('does not flag functions called only from a top-level if __name__ == "__main__" dispatch block', () => {
    // Real bug found via a live user test on kishanrajput23/Jarvis-Desktop-Voice-Assistant:
    // 7 of 10 functions (70%) were flagged dead, every one called via a literal
    // name() invocation sitting inside a top-level if/elif dispatch block -
    // invisible because the parser only ever scanned inside function bodies.
    const source = `
def wishme():
    speak("hello")

def tell_time():
    speak("the time is now")

if __name__ == "__main__":
    wishme()
    query = "time"
    if "time" in query:
        tell_time()
`;
    const dead = findDeadCode([parsePy(source)]);
    const names = dead.map((d) => d.function.name);
    expect(names).not.toContain('wishme');
    expect(names).not.toContain('tell_time');
  });

  it('does not flag a function referenced only as a dict value (command-dispatch table idiom)', () => {
    const source = `
def play_music():
    pass

def show_time():
    pass

commands = {
    "play": play_music,
    "time": show_time,
}
`;
    const dead = findDeadCode([parsePy(source)]);
    const names = dead.map((d) => d.function.name);
    expect(names).not.toContain('play_music');
    expect(names).not.toContain('show_time');
  });

  it('does not flag a function referenced only via a decorator', () => {
    const source = `
def my_decorator(fn):
    return fn

@my_decorator
def handler():
    pass
`;
    const dead = findDeadCode([parsePy(source)]);
    expect(dead.map((d) => d.function.name)).not.toContain('my_decorator');
  });

  it('still flags a genuinely unused function as dead (regression guard)', () => {
    const source = `
def used():
    pass

def truly_unused():
    pass

if __name__ == "__main__":
    used()
`;
    const dead = findDeadCode([parsePy(source)]);
    expect(dead.map((d) => d.function.name)).toContain('truly_unused');
  });

  it('does not corrupt call detection when a docstring or comment mentions a function name', () => {
    const source = `
def real_target():
    pass

def caller():
    """This function calls real_target() as documented."""
    # real_target() is invoked below
    real_target()
`;
    const dead = findDeadCode([parsePy(source)]);
    expect(dead.map((d) => d.function.name)).not.toContain('real_target');
  });
});
