// jest-expo only transforms `.[jt]sx?`; Better Auth ships ESM-only `.mjs`, so reuse the exact same
// babel-jest + babel-preset-expo options for `.mjs` (Node 22 can't require() ESM natively).
const preset = require('jest-expo/jest-preset');

const [babelJestPath, options] = preset.transform['\\.[jt]sx?$'];
const babelJest = require(babelJestPath);

module.exports = (babelJest.default ?? babelJest).createTransformer(options);
