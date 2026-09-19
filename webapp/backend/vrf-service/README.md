# vrf-service

Node.js REST wrapper for Switchboard VRF actions.

## Endpoints

- `GET /health`
- `POST /v1/randomness-accounts`
- `POST /v1/randomness-accounts/close` with JSON body `{ "randomness_account": "...", "destination": "optional_pubkey" }`
- `POST /v1/randomness-requests` with JSON body `{ "randomness_account": "..." }`
- `POST /v1/randomness-reveal` with JSON body `{ "randomness_account": "..." }`
- `GET /v1/randomness-accounts/:randomnessAccount`

## Env

Copy `.env.example` to `.env` and set:

- `SWITCHBOARD_SIGNER_KEYPAIR_JSON` (JSON array of 64 bytes)
- `SOLANA_RPC_URL` (default `https://api.mainnet-beta.solana.com`)
- `SWITCHBOARD_ON_DEMAND_PROGRAM_ID` (default already set)
- `SWITCHBOARD_QUEUE` (recommended to set explicitly)
- `VRF_SERVICE_API_KEY` (optional)
- `PORT` (default `8787`)
- `VRF_FALLBACK_ATTEMPTS` (default `2`)

## Run

```bash
cd vrf-service
npm install
npm start
```

## Docker

```bash
docker build -t lottery-vrf-service:0.0.1 .
docker run --rm -p 8787:8787 --env-file .env lottery-vrf-service:0.0.1
```
