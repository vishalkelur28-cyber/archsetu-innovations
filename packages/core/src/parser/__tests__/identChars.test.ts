import { describe, expect, it } from 'vitest';
import { IDENT } from '../BaseParser.js';

/**
 * `\w` is ASCII-only in JavaScript regex, so every parser built on it silently
 * dropped any function whose name is not spelled in ASCII. Measured across
 * eight languages before this fix, nine of sixteen declarations were found:
 * `function crearé()` was invisible while `function normal()` beside it was
 * fine. Ruby was worse than a miss - it captured `crearé` as `crear`, a wrong
 * name that can match some other function and create a false call-graph edge.
 */
describe('IDENT', () => {
  const nameRe = new RegExp(`function (${IDENT})\\s*\\(`);

  it('captures identifiers written in scripts other than Latin ASCII', () => {
    const cases: Array<[string, string]> = [
      ['function normal() {}', 'normal'],
      ['function crearé() {}', 'crearé'],
      ['function año() {}', 'año'],
      ['function पर() {}', 'पर'],
      ['function 名前() {}', '名前'],
      ['function Привет() {}', 'Привет'],
      ['function ελληνικά() {}', 'ελληνικά'],
      ['function 이름() {}', '이름'],
      ['function _private$1() {}', '_private$1'],
    ];

    for (const [source, expected] of cases) {
      expect(source.match(nameRe)?.[1], source).toBe(expected);
    }
  });

  it('still treats punctuation and whitespace as a boundary', () => {
    // The ranges deliberately stop short of General Punctuation, so a dash or
    // a quote beside a name remains a boundary rather than becoming part of it.
    const re = new RegExp(`(${IDENT})`);
    expect(re.exec('a-b')?.[1]).toBe('a');
    expect(re.exec('a.b')?.[1]).toBe('a');
    expect(re.exec('a b')?.[1]).toBe('a');
    expect(re.exec('a–b')?.[1]).toBe('a'); // en dash
    expect(re.exec('a(b')?.[1]).toBe('a');
  });

  it('is a valid regex fragment on its own', () => {
    expect(() => new RegExp(IDENT)).not.toThrow();
    expect(() => new RegExp(`^${IDENT}$`)).not.toThrow();
  });
});
