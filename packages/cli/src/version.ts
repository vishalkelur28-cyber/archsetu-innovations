/**
 * The published version of this package, in one place.
 *
 * It is a hand-maintained constant rather than a read of package.json
 * because the build bundles src/ into a single ESM file in dist/, where a
 * relative import or createRequire of ../package.json resolves differently
 * than it does from source - and getting that wrong fails at runtime on a
 * user's machine, not in CI.
 *
 * Keep it in step with package.json's "version". It is not cosmetic: the MCP
 * server reports it as its serverInfo.version, which is what a client
 * displays and what a bug report will quote.
 */
export const CLI_VERSION = '0.1.23';
