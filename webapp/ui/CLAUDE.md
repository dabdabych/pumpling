# CLAUDE.md — Frontend (Angular)

The Angular SPA. Two zones: the public site and the admin area. There is no
user dashboard any more: rounds are created and driven by
`lottery_phase_worker`, admins come from `LOTTERY_ADMIN_PUBKEYS`, and manual
control lives in the admin area. Talks to `webapp/backend` (FastAPI).

## Layout (src/app/)

```
public/        # the public site: main page, how it works, sign in
pool/          # the pool page: coin table, commit dialog, purchase feed
archive/       # past rounds
me/            # a participant's own commits and history
chat/          # chat for signed-in users
admin/         # manual control over a round
auth/          # sign in and session
shared/        # shared services and components: wallet, verify-round,
               #   blocked-bet-mints, error.interceptor
api-client/    # generated client for the backend API
store/         # state management
idl/           # the Anchor IDL (lottery_v_1_0.json) — types of the on-chain program
helpers/       # utilities
```

Root: `app.module.ts`, `app-routing.module.ts`, `app.component.ts`,
`token.interceptor.ts` (puts the JWT into headers).

## Environments

`src/environments/environment.ts` (dev) and `environment.prod.ts` (prod) hold
the backend base URL, the RPC and so on. The production build swaps the file.
Anything that has to change without a rebuild is read at runtime from
`/environment.json`, which nginx renders from container environment variables
(see `nginx.conf` and the `ui` service in `docker-compose.yml`).

## Running

```bash
npm install && npm start          # ng serve, locally
docker compose up -d ui           # production (service ui, image lottery-ui)
```

## Tests

```bash
npm run test:scenes               # the maths behind the landing animations and the fee picker
npm start                         # then, in another shell:
npm run e2e                       # browser suites against a real Chrome
```

`e2e/` drives a real browser through `playwright-core` and the system Chrome.
The suites cover what a unit test cannot reach: animations and scroll, the
commit flow on a phone, wallet connection and switching, how often the page
polls the server, the archive, and whether a participant can find their own
money in the table. `e2e/README.md` explains how to run one suite and how to
add another.

Rule for this folder: a new suite has to fail on the code as it was before the
fix. A test that passes either way proves nothing.

NB: `idl/` must match the on-chain program and the backend. When the IDL
changes, update `workers/idl/` in the same commit.
