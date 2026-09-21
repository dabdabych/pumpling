export const environment = {
  production: true,
  apiUrl: '/api',
  solanaRpcUrl: `${globalThis.location.origin}/api/rpc`,
  solanaCluster: 'mainnet-beta' as const,
  solanaWalletAuthChain: 'solana/mainnet',
  // Where the "how to check this yourself" link leads: the public repository with
  // the algorithm described. Changed through environment.json, with no rebuild.
  verifyDocsUrl: 'https://github.com/dabdabych/pumpling',
  // Before launch the root shows the placeholder instead of the main page:
  // the mascot, the launch date, sign-in and the community chat. Set at runtime
  // from environment.json, so opening the site needs no rebuild.
  comingSoon: false,
  solanaExplorerQuery: '',
  // 32-byte hash in hex (64 chars), optional 0x prefix.
  vrfAlgorithmHash: '0x00a9da1268f2d909dbf6700a15ec3f902630c5194306bfffcf713150279d831b'
};
