/**
 * Keeps Pi's own package lookups on this repository's `node_modules`.
 *
 * Pi reads `PI_PACKAGE_DIR` when it is set and takes `VERSION` and its asset
 * paths from whatever install that names. A shell started by an agent can carry
 * the variable for a global install, which would make a run measure a different
 * package than the one `package.json` pins and `npm ci` installed.
 *
 * Import this module before anything that imports Pi. Modules are evaluated
 * depth-first in source order, so a later `import` of Pi would already have read
 * the variable.
 */

delete process.env.PI_PACKAGE_DIR;
