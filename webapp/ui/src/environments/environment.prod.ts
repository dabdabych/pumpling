export const environment = {
  production: true,
  apiUrl: '/api',
  solanaRpcUrl: `${globalThis.location.origin}/api/rpc`,
  solanaCluster: 'mainnet-beta' as const,
  solanaWalletAuthChain: 'solana/mainnet',
  // Where the "how to check this yourself" link leads: the public repository with
  // the algorithm described. Changed through environment.json, with no rebuild.
  verifyDocsUrl: 'https://github.com/qres-crypto/public-docs',
  solanaExplorerQuery: '',
  // 32-byte hash in hex (64 chars), optional 0x prefix.
  vrfAlgorithmHash: '0x2ec9c530fcd55efd0838bd79245e2543e24f41cd3c2d660eaff43c0387629929'
};
