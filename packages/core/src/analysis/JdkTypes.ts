import { JDK_TYPES } from './jdkModel.js';

/** A Java standard library type, as recorded in the generated jdkModel.ts. */
export interface JdkType {
  isFinal: boolean;
  isInterface: boolean;
  /** Every supertype, by simple name; `Object` included. */
  supertypes: ReadonlySet<string>;
  /** What the method of that name returns, as the model names types; `?` where a type variable or disagreeing overloads leave it open, undefined when the type has no such method. */
  returnTypeOf(method: string): string | undefined;
}

const parsed = new Map<string, JdkType | null>();

/**
 * The standard library type a name written in Java source refers to: `List`,
 * `java.util.List`, `Map.Entry`. Null for anything else, including a type
 * qualified with a package outside `java.` - a library's own `Optional` is
 * not java.util.Optional.
 */
export function jdkType(written: string): JdkType | null {
  const name = written.replace(/(\[\])+$/, '');
  const cached = parsed.get(name);
  if (cached !== undefined) return cached;
  const type = parse(name);
  parsed.set(name, type);
  return type;
}

function parse(name: string): JdkType | null {
  const segments = name.split('.');
  const firstType = segments.findIndex((s) => /^[A-Z]/.test(s));
  if (firstType < 0) return null;
  if (firstType > 0 && segments[0] !== 'java') return null;
  const entry = JDK_TYPES[segments.slice(firstType).join('.')];
  if (entry === undefined) return null;
  const [flags = '', supertypes = '', methods = ''] = entry.split('|');
  let returns: Map<string, string> | undefined;
  return {
    isFinal: flags.includes('f'),
    isInterface: flags.includes('i'),
    supertypes: new Set(supertypes ? supertypes.split(',') : []),
    returnTypeOf(method: string): string | undefined {
      if (!returns) {
        returns = new Map();
        for (const pair of methods ? methods.split(',') : []) {
          const colon = pair.indexOf(':');
          returns.set(pair.slice(0, colon), pair.slice(colon + 1));
        }
      }
      return returns.get(method) ?? (method === 'toString' ? 'String' : method === 'hashCode' ? 'int' : method === 'equals' ? 'boolean' : undefined);
    },
  };
}
