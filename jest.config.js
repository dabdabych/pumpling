/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      roots: ['<rootDir>/offchain/tests/unit'],
      testMatch: ['**/*.test.ts'],
      setupFilesAfterEnv: ['<rootDir>/offchain/tests/setup.ts'],
      moduleFileExtensions: ['ts', 'js', 'json'],
      transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
      },
      moduleNameMapper: {
        '^../../src/(.*)$': '<rootDir>/offchain/$1',
      },
    },
    {
      displayName: 'integration',
      preset: 'ts-jest',
      testEnvironment: 'node',
      roots: ['<rootDir>/offchain/tests/integration'],
      testMatch: ['**/*.test.ts'],
      setupFilesAfterEnv: ['<rootDir>/offchain/tests/setup.ts'],
      moduleFileExtensions: ['ts', 'js', 'json'],
      testEnvironmentOptions: { testTimeout: 120000 },
      transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
      },
      moduleNameMapper: {
        '^../../src/(.*)$': '<rootDir>/offchain/$1',
      },
    },
  ],
};
