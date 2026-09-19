const express = require('express');
const dotenv = require('dotenv');
const crypto = require('node:crypto');
const anchor = require('@coral-xyz/anchor');
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');

dotenv.config();

const app = express();
app.use(express.json());

const port = Number(process.env.PORT || 8787);
const apiKey = (process.env.VRF_SERVICE_API_KEY || '').trim();
const rpcUrl = (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com').trim();
const onDemandProgramId = (
  process.env.SWITCHBOARD_ON_DEMAND_PROGRAM_ID ||
  'Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2'
).trim();
const queuePubkeyRaw = (process.env.SWITCHBOARD_QUEUE || '').trim();
const signerKeypairJson = (process.env.SWITCHBOARD_SIGNER_KEYPAIR_JSON || '').trim();
const randomnessAccountReadyTimeoutMs = Number(
  process.env.RANDOMNESS_ACCOUNT_READY_TIMEOUT_MS || 20_000
);
const randomnessAccountReadyPollMs = Number(
  process.env.RANDOMNESS_ACCOUNT_READY_POLL_MS || 500
);

let sbSdkPromise = null;

function logInfo(event, fields = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    event,
    ...fields,
  }));
}

function logWarn(event, fields = {}) {
  console.warn(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'warn',
    event,
    ...fields,
  }));
}

function logError(event, fields = {}) {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    event,
    ...fields,
  }));
}

function toErrorFields(error) {
  if (!error) {
    return { error_message: 'unknown error' };
  }
  return {
    error_name: error.name || 'Error',
    error_message: error.message || String(error),
    error_stack: error.stack || null,
  };
}

function loadSdk() {
  if (!sbSdkPromise) {
    sbSdkPromise = import('@switchboard-xyz/on-demand');
  }
  return sbSdkPromise;
}

function requireApiKey(req, res, next) {
  if (!apiKey) {
    return next();
  }

  const candidate = (req.header('x-api-key') || '').trim();
  if (!candidate || candidate !== apiKey) {
    logWarn('http.auth.unauthorized', {
      method: req.method,
      path: req.path,
    });
    return res.status(401).json({ detail: 'Unauthorized' });
  }
  return next();
}

app.use(requireApiKey);

function parseSigner() {
  if (!signerKeypairJson) {
    throw new Error('SWITCHBOARD_SIGNER_KEYPAIR_JSON is not configured');
  }

  let parsed;
  try {
    parsed = JSON.parse(signerKeypairJson);
  } catch (error) {
    throw new Error('SWITCHBOARD_SIGNER_KEYPAIR_JSON must be valid JSON array');
  }

  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error('SWITCHBOARD_SIGNER_KEYPAIR_JSON must be an array of 64 integers');
  }

  const normalized = parsed.map((value) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      throw new Error('SWITCHBOARD_SIGNER_KEYPAIR_JSON must contain integers in range 0..255');
    }
    return n;
  });

  return Keypair.fromSecretKey(Uint8Array.from(normalized));
}

function getWallet(payer) {
  return new anchor.Wallet(payer);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAccountOwner(connection, account, expectedOwner) {
  const deadline = Date.now() + randomnessAccountReadyTimeoutMs;
  let lastOwner = null;

  while (Date.now() < deadline) {
    const info = await connection.getAccountInfo(account, 'confirmed');
    lastOwner = info?.owner?.toBase58() || null;
    if (lastOwner === expectedOwner.toBase58()) {
      return;
    }
    await sleep(randomnessAccountReadyPollMs);
  }

  throw new Error(
    `Randomness account ${account.toBase58()} was not visible with owner ` +
    `${expectedOwner.toBase58()} within ${randomnessAccountReadyTimeoutMs}ms ` +
    `(last owner: ${lastOwner || 'missing'})`
  );
}

function extractPubkeyString(value) {
  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof PublicKey) {
    return value.toBase58();
  }

  if (value.publicKey instanceof PublicKey) {
    return value.publicKey.toBase58();
  }

  if (value.pubkey instanceof PublicKey) {
    return value.pubkey.toBase58();
  }

  if (typeof value.publicKey === 'string') {
    return value.publicKey;
  }

  if (typeof value.pubkey === 'string') {
    return value.pubkey;
  }

  return '';
}

function extractSignature(value) {
  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim().split(/\s+/)[0] || '';
  }

  if (typeof value === 'object') {
    for (const key of ['request_id', 'signature', 'txSignature', 'transactionSignature', 'tx', 'id']) {
      if (value[key]) {
        return String(value[key]).trim().split(/\s+/)[0] || '';
      }
    }
  }

  return '';
}

function toHexFromBytes(value) {
  if (!value) {
    return null;
  }
  if (Buffer.isBuffer(value)) {
    return `0x${value.toString('hex')}`;
  }
  if (value instanceof Uint8Array) {
    return `0x${Buffer.from(value).toString('hex')}`;
  }
  if (Array.isArray(value) && value.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
    return `0x${Buffer.from(value).toString('hex')}`;
  }
  return null;
}

function serializeForJson(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (value instanceof PublicKey) {
    return value.toBase58();
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Buffer.isBuffer(value)) {
    return {
      hex: `0x${value.toString('hex')}`,
      base64: value.toString('base64'),
    };
  }
  if (value instanceof Uint8Array) {
    const buf = Buffer.from(value);
    return {
      hex: `0x${buf.toString('hex')}`,
      base64: buf.toString('base64'),
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeForJson(item));
  }
  if (typeof value === 'object') {
    if (value.constructor && value.constructor.name === 'BN' && typeof value.toString === 'function') {
      return value.toString();
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = serializeForJson(v);
    }
    return out;
  }
  return value;
}

async function resolveQueue(sbSdk, context) {
  const { connection, sbProgram } = context;

  if (queuePubkeyRaw) {
    return new PublicKey(queuePubkeyRaw);
  }

  if (typeof sbSdk.getDefaultQueue === 'function') {
    return await sbSdk.getDefaultQueue(connection.rpcEndpoint);
  }

  if (sbSdk.Queue && typeof sbSdk.Queue.loadDefault === 'function') {
    return await sbSdk.Queue.loadDefault(sbProgram ?? connection);
  }

  throw new Error('Unable to resolve Switchboard queue. Set SWITCHBOARD_QUEUE in env');
}

function resolveQueuePubkey(queue) {
  if (!queue) {
    throw new Error('Switchboard queue is not resolved');
  }

  if (queue instanceof PublicKey) {
    return queue;
  }

  if (typeof queue === 'string') {
    return new PublicKey(queue);
  }

  const candidates = [
    queue.publicKey,
    queue.pubkey,
    queue.key,
    queue?.account?.publicKey,
    queue?.account?.pubkey,
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (candidate instanceof PublicKey) {
      return candidate;
    }
    if (typeof candidate === 'string') {
      return new PublicKey(candidate);
    }
  }

  throw new Error('Resolved queue is not a valid PublicKey');
}

function supportsAllKeys(target, keys) {
  const source = target && typeof target === 'object' ? target : {};
  return keys.every((key) => Object.prototype.hasOwnProperty.call(source, key));
}

async function resolveProgram(sbSdk, connection, payer) {
  const wallet = getWallet(payer);
  if (sbSdk.AnchorUtils && typeof sbSdk.AnchorUtils.loadProgramFromConnection === 'function') {
    return await sbSdk.AnchorUtils.loadProgramFromConnection(
      connection,
      wallet,
      new PublicKey(onDemandProgramId),
    );
  }

  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
  });
  if (sbSdk.AnchorUtils && typeof sbSdk.AnchorUtils.loadProgramFromProvider === 'function') {
    return await sbSdk.AnchorUtils.loadProgramFromProvider(provider, new PublicKey(onDemandProgramId));
  }

  throw new Error('Switchboard SDK does not expose AnchorUtils.loadProgramFromConnection/loadProgramFromProvider');
}

async function sendIx(connection, payer, ix, extraSigners = []) {
  const tx = new Transaction().add(ix);
  const signature = await sendAndConfirmTransaction(connection, tx, [payer, ...extraSigners], {
    commitment: 'confirmed',
  });
  return signature;
}

async function createSdkContext() {
  const sbSdk = await loadSdk();
  const connection = new Connection(rpcUrl, 'confirmed');
  const payer = parseSigner();
  const sbProgram = await resolveProgram(sbSdk, connection, payer);
  const queue = await resolveQueue(sbSdk, { connection, sbProgram });

  return {
    sbSdk,
    connection,
    payer,
    sbProgram,
    queue,
  };
}

function parseCreateResult(result) {
  if (Array.isArray(result)) {
    return {
      randomnessAccountLike: result[0],
      createIx: result[1],
    };
  }

  if (result && typeof result === 'object') {
    if (supportsAllKeys(result, ['randomness', 'createIx'])) {
      return {
        randomnessAccountLike: result.randomness,
        createIx: result.createIx,
      };
    }

    if (supportsAllKeys(result, ['account', 'ix'])) {
      return {
        randomnessAccountLike: result.account,
        createIx: result.ix,
      };
    }
  }

  return {
    randomnessAccountLike: null,
    createIx: null,
  };
}

async function createRandomnessAccountSdk() {
  const opId = crypto.randomUUID();
  logInfo('switchboard.randomness_account.create.started', { op_id: opId });
  const { sbSdk, connection, payer, sbProgram, queue } = await createSdkContext();
  const queuePubkey = resolveQueuePubkey(queue);
  logInfo('switchboard.randomness_account.create.context_ready', {
    op_id: opId,
    payer: payer.publicKey.toBase58(),
    queue_pubkey: queuePubkey.toBase58(),
    rpc_url: connection.rpcEndpoint,
  });

  if (!sbSdk.Randomness || typeof sbSdk.Randomness.create !== 'function') {
    logError('switchboard.randomness_account.create.failed', {
      op_id: opId,
      reason: 'Randomness.create is unavailable',
    });
    throw new Error('Switchboard SDK does not expose Randomness.create');
  }

  const rngKeypair = Keypair.generate();
  logInfo('switchboard.randomness_account.create.keypair_generated', {
    op_id: opId,
    generated_pubkey: rngKeypair.publicKey.toBase58(),
  });
  const created = await sbSdk.Randomness.create(sbProgram, rngKeypair, queuePubkey);
  const parsed = parseCreateResult(created);
  const randomnessAccount = extractPubkeyString(parsed.randomnessAccountLike) || rngKeypair.publicKey.toBase58();

  if (parsed.createIx) {
    const signature = await sendIx(connection, payer, parsed.createIx, [rngKeypair]);
    logInfo('switchboard.randomness_account.create.ix_sent', {
      op_id: opId,
      signature,
      randomness_account: randomnessAccount,
    });
  } else {
    logInfo('switchboard.randomness_account.create.without_ix', {
      op_id: opId,
      randomness_account: randomnessAccount,
    });
  }

  await waitForAccountOwner(
    connection,
    new PublicKey(randomnessAccount),
    new PublicKey(onDemandProgramId)
  );
  logInfo('switchboard.randomness_account.create.ready', {
    op_id: opId,
    randomness_account: randomnessAccount,
  });

  logInfo('switchboard.randomness_account.create.succeeded', {
    op_id: opId,
    randomness_account: randomnessAccount,
  });
  return randomnessAccount;
}

function resolveRandomnessAccountObject(sbSdk, sbProgram, randomnessAccount) {
  const publicKey = new PublicKey(randomnessAccount);

  if (sbSdk.Randomness && typeof sbSdk.Randomness === 'function') {
    return new sbSdk.Randomness(sbProgram, publicKey);
  }

  throw new Error('Switchboard SDK does not expose Randomness class');
}

async function requestRandomnessSdk(randomnessAccount) {
  const opId = crypto.randomUUID();
  logInfo('switchboard.randomness.request.started', {
    op_id: opId,
    randomness_account: randomnessAccount,
  });
  const { sbSdk, connection, payer, sbProgram, queue } = await createSdkContext();
  const queuePubkey = resolveQueuePubkey(queue);
  const randomness = resolveRandomnessAccountObject(sbSdk, sbProgram, randomnessAccount);
  logInfo('switchboard.randomness.request.context_ready', {
    op_id: opId,
    payer: payer.publicKey.toBase58(),
    queue_pubkey: queuePubkey.toBase58(),
    rpc_url: connection.rpcEndpoint,
    randomness_account: randomnessAccount,
  });

  if (!randomness || typeof randomness.commitIx !== 'function') {
    logError('switchboard.randomness.request.failed', {
      op_id: opId,
      randomness_account: randomnessAccount,
      reason: 'Randomness.commitIx is unavailable',
    });
    throw new Error('Switchboard SDK Randomness.commitIx is not available');
  }

  const commitIx = await randomness.commitIx(queuePubkey, payer.publicKey);
  logInfo('switchboard.randomness.request.commit_ix_ready', {
    op_id: opId,
    randomness_account: randomnessAccount,
  });
  const signature = await sendIx(connection, payer, commitIx);
  if (!signature) {
    logError('switchboard.randomness.request.failed', {
      op_id: opId,
      randomness_account: randomnessAccount,
      reason: 'empty signature',
    });
    throw new Error('Failed to submit commit transaction');
  }
  logInfo('switchboard.randomness.request.succeeded', {
    op_id: opId,
    randomness_account: randomnessAccount,
    signature,
  });
  return signature;
}

async function closeRandomnessAccountSdk(randomnessAccount, destination) {
  const { sbSdk, connection, payer, sbProgram } = await createSdkContext();
  const randomness = resolveRandomnessAccountObject(sbSdk, sbProgram, randomnessAccount);

  if (destination) {
    throw new Error('destination override is not supported by this SDK version (closeIx has no destination arg)');
  }

  if (!randomness || typeof randomness.closeIx !== 'function') {
    throw new Error('Switchboard SDK Randomness.closeIx is not available');
  }

  const closeIx = await randomness.closeIx();
  const signature = await sendIx(connection, payer, closeIx);
  if (!signature) {
    throw new Error('Failed to submit close transaction');
  }
  return signature;
}

async function getRandomnessAccountDataSdk(randomnessAccount) {
  const { sbSdk, sbProgram } = await createSdkContext();
  const randomness = resolveRandomnessAccountObject(sbSdk, sbProgram, randomnessAccount);
  if (!randomness || typeof randomness.loadData !== 'function') {
    throw new Error('Switchboard SDK Randomness.loadData is not available');
  }

  const data = await randomness.loadData();
  const serialized = serializeForJson(data);
  const valueHex =
    toHexFromBytes(data?.value) ||
    toHexFromBytes(data?.result) ||
    toHexFromBytes(serialized?.value) ||
    toHexFromBytes(serialized?.result);

  return {
    data: serialized,
    value_hex: valueHex,
  };
}

async function revealRandomnessSdk(randomnessAccount) {
  const { sbSdk, connection, payer, sbProgram } = await createSdkContext();
  const randomness = resolveRandomnessAccountObject(sbSdk, sbProgram, randomnessAccount);

  if (!randomness || typeof randomness.revealIx !== 'function') {
    throw new Error('Switchboard SDK Randomness.revealIx is not available');
  }

  const revealIx = await randomness.revealIx(payer.publicKey);
  const revealSignature = await sendIx(connection, payer, revealIx);
  if (!revealSignature) {
    throw new Error('Failed to submit reveal transaction');
  }

  const { data, value_hex } = await getRandomnessAccountDataSdk(randomnessAccount);
  return {
    reveal_signature: revealSignature,
    data,
    value_hex,
  };
}

app.get('/health', async (_req, res) => {
  if (!signerKeypairJson) {
    return res.status(503).json({
      ok: false,
      detail: 'SWITCHBOARD_SIGNER_KEYPAIR_JSON is not configured',
    });
  }

  try {
    const payer = parseSigner();
    res.json({ ok: true, payer: payer.publicKey.toBase58(), rpc_url: rpcUrl });
  } catch (error) {
    res.status(503).json({ ok: false, detail: error.message });
  }
});

app.post('/v1/randomness-accounts', async (_req, res) => {
  const requestId = crypto.randomUUID();
  logInfo('http.randomness_accounts.create.started', { request_id: requestId });
  try {
    const randomnessAccount = await createRandomnessAccountSdk();
    logInfo('http.randomness_accounts.create.succeeded', {
      request_id: requestId,
      randomness_account: randomnessAccount,
    });
    return res.json({ randomness_account: randomnessAccount });
  } catch (error) {
    logError('http.randomness_accounts.create.failed', {
      request_id: requestId,
      ...toErrorFields(error),
    });
    return res.status(500).json({
      detail: 'Failed to create randomness account',
      error_detail: error?.message || String(error),
    });
  }
});

app.post('/v1/randomness-accounts/close', async (req, res) => {
  const randomnessAccount = String(req.body?.randomness_account || '').trim();
  const destination = String(req.body?.destination || '').trim();

  if (!randomnessAccount) {
    return res.status(400).json({ detail: 'randomness_account is required' });
  }

  try {
    const closeSignature = await closeRandomnessAccountSdk(randomnessAccount, destination);
    return res.json({
      randomness_account: randomnessAccount,
      destination: destination || undefined,
      close_signature: closeSignature,
    });
  } catch (error) {
    return res.status(500).json({ detail: `Failed to close randomness account: ${error.message}` });
  }
});

app.post('/v1/randomness-requests', async (req, res) => {
  const randomnessAccount = String(req.body?.randomness_account || '').trim();
  if (!randomnessAccount) {
    logWarn('http.randomness_requests.bad_request', { reason: 'missing randomness_account' });
    return res.status(400).json({ detail: 'randomness_account is required' });
  }

  const traceId = crypto.randomUUID();
  logInfo('http.randomness_requests.started', {
    request_id: traceId,
    randomness_account: randomnessAccount,
  });
  try {
    const switchboardRequestId = await requestRandomnessSdk(randomnessAccount);
    logInfo('http.randomness_requests.succeeded', {
      request_id: traceId,
      switchboard_request_id: switchboardRequestId,
      randomness_account: randomnessAccount,
    });
    return res.json({ randomness_account: randomnessAccount, request_id: switchboardRequestId });
  } catch (error) {
    logError('http.randomness_requests.failed', {
      request_id: traceId,
      randomness_account: randomnessAccount,
      ...toErrorFields(error),
    });
    return res.status(500).json({
      detail: 'Failed to request randomness',
      error_detail: error?.message || String(error),
    });
  }
});

app.post('/v1/randomness-reveal', async (req, res) => {
  const randomnessAccount = String(req.body?.randomness_account || '').trim();
  if (!randomnessAccount) {
    logWarn('http.randomness_reveal.bad_request', { reason: 'missing randomness_account' });
    return res.status(400).json({ detail: 'randomness_account is required' });
  }

  const traceId = crypto.randomUUID();
  logInfo('http.randomness_reveal.started', {
    request_id: traceId,
    randomness_account: randomnessAccount,
  });
  try {
    const result = await revealRandomnessSdk(randomnessAccount);
    logInfo('http.randomness_reveal.succeeded', {
      request_id: traceId,
      randomness_account: randomnessAccount,
      reveal_signature: result.reveal_signature || null,
    });
    return res.json({
      randomness_account: randomnessAccount,
      reveal_signature: result.reveal_signature,
      value_hex: result.value_hex,
      data: result.data,
    });
  } catch (error) {
    logError('http.randomness_reveal.failed', {
      request_id: traceId,
      randomness_account: randomnessAccount,
      ...toErrorFields(error),
    });
    return res.status(500).json({
      detail: 'Failed to reveal randomness',
      error_detail: error?.message || String(error),
    });
  }
});

app.get('/v1/randomness-accounts/:randomnessAccount', async (req, res) => {
  const randomnessAccount = String(req.params?.randomnessAccount || '').trim();
  if (!randomnessAccount) {
    return res.status(400).json({ detail: 'randomnessAccount path param is required' });
  }

  try {
    const result = await getRandomnessAccountDataSdk(randomnessAccount);
    return res.json({
      randomness_account: randomnessAccount,
      value_hex: result.value_hex,
      data: result.data,
    });
  } catch (error) {
    return res.status(500).json({ detail: `Failed to fetch randomness account: ${error.message}` });
  }
});

app.listen(port, () => {
  logInfo('vrf-service.started', {
    port,
    rpc_url: rpcUrl,
    on_demand_program_id: onDemandProgramId,
    queue_pubkey: queuePubkeyRaw || null,
  });
});
