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
  vrfAlgorithmHash: '0x00a9da1268f2d909dbf6700a15ec3f902630c5194306bfffcf713150279d831b'
};
