/**
 * TypeScript compiler using esbuild
 * Compiles TypeScript scripts to JavaScript for execution in the sandbox
 */

const { transformSync } = require('esbuild');

/**
 * Compiles TypeScript code to JavaScript
 * @param {string} tsCode - TypeScript source code
 * @returns {string} - Compiled JavaScript code
 * @throws {Error} - If compilation fails
 */
function compileTypeScript(tsCode) {
  try {
    const result = transformSync(tsCode, {
      loader: 'ts',
      target: 'es2020',
      format: 'cjs',
      sourcemap: false,
      minify: false,
      // Keep names for better error messages
      keepNames: true,
    });

    return result.code;
  } catch (error) {
    throw new Error(`TypeScript compilation failed: ${error.message}`);
  }
}

module.exports = { compileTypeScript };
