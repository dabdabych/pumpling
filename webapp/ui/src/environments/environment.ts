// This file can be replaced during build by using the `fileReplacements` array.
// `ng build` replaces `environment.ts` with `environment.prod.ts`.
// The list of file replacements can be found in `angular.json`.

export const environment = {
  production: false,
  apiUrl: 'http://localhost:9876',
  solanaRpcUrl: 'http://localhost:8000/rpc',
  solanaCluster: 'devnet' as const,
  solanaWalletAuthChain: 'solana/devnet',
  // Where the "how to check this yourself" link leads: the public repository with
  // the algorithm described. Changed through environment.json, with no rebuild.
  verifyDocsUrl: 'https://github.com/qres-crypto/public-docs',
  solanaExplorerQuery: '?cluster=devnet',
  // 32-byte hash in hex (64 chars), optional 0x prefix.
  vrfAlgorithmHash: '0x2ec9c530fcd55efd0838bd79245e2543e24f41cd3c2d660eaff43c0387629929'
};

/*
 * For easier debugging in development mode, you can import the following file
 * to ignore zone related error stack frames such as `zone.run`, `zoneDelegate.invokeTask`.
 *
 * This import should be commented out in production mode because it will have a negative impact
 * on performance if an error is thrown.
 */
// import 'zone.js/plugins/zone-error';  // Included with Angular CLI.
