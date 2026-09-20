# CLAUDE.md — Infrastructure and monitoring

The observability stack is **Loki** for logs and **Grafana** for dashboards.
Logs are shipped by the docker `loki` logging driver (pushed to
`http://localhost:3100/loki/api/v1/push`), and dashboards and datasources are
provisioned from files: Grafana is configured as code, not by hand.

## Files

```
infra/
├── loki-config.yml                          # Loki config
└── grafana/provisioning/
    ├── datasources/loki.yml                 # the Loki datasource
    ├── alerting/                            # alert rules, contact point, routing
    └── dashboards/
        ├── provider.yml                     # dashboard provider (folder, path)
        ├── errors-and-alerts.json           # dashboard: errors and alerts (P1)
        ├── metrics-and-operations.json      # dashboard: metrics and operations (P2)
        └── SCENARIOS.md                     # WHAT to monitor: scenarios and every pino event
```

`SCENARIOS.md` is the detailed reference: which events the buyer emits, which
LogQL queries to build, and the P1/P2 priorities. Read it before editing a
dashboard or adding logs.

## Running

```bash
# production — with the whole stack
./deploy.sh                        # docker compose up -d

# locally — monitoring only
docker compose up -d loki grafana
```

- Grafana: http://localhost:3001 (user `admin`, password from `GRAFANA_PASSWORD` in `.env`)
- Loki: http://localhost:3100

Note: `docker-compose.yml` needs `SWITCHBOARD_SIGNER_KEYPAIR_JSON` for
`.env` even when you only bring up some of the services (`dummy` will do
locally).

To pour synthetic logs in and check the dashboards:
```bash
python3 scripts/seed-loki.py       # 600 lines over the last 30 minutes
```

## Things that will trip you up

**After editing provisioning**, restart Grafana so it re-reads the config:
```bash
docker restart lottery-grafana
```

**`container name "lottery-loki" already in use`** means there is a legacy
container that did not come from compose (no
`com.docker.compose.project=solana-buyer` label). It sits on the default
`bridge` network while Grafana is on `solana-buyer_default`, so Grafana cannot
reach Loki by host name and the dashboards come up empty or time out on DNS.
Check the label and recreate it:
```bash
docker inspect lottery-loki --format '{{index .Config.Labels "com.docker.compose.project"}}'
docker stop lottery-loki && docker rm lottery-loki
docker compose up -d --no-deps loki
docker restart lottery-grafana
```

**A dashboard refuses to move to another folder** after you change `folder` in
`provider.yml` or change the UID. Grafana will not move an existing provisioned
dashboard and will not let the API delete it (`"provisioned dashboard cannot be
deleted"`). The fix is to recreate the metadata volume; the configs live in
files and survive:
```bash
docker stop lottery-grafana && docker rm lottery-grafana
docker volume rm solana-buyer_grafana_data
docker compose up -d --no-deps grafana
```

## Alerts

The rules are in `grafana/provisioning/alerting/`: three of them, all over logs
in Loki.

| Rule | Fires when | Why it is an incident |
|---|---|---|
| Buyer is throwing errors | `level=error` from `lottery-buyer` for five minutes straight | the buying may not finish and participants' SOL stays on the keeper |
| Round stuck in a phase | the phase worker logs `lifecycle-stuck` | the pool did not close, the draw did not run, or the buying never started |
| Phase worker has gone silent | no `lifecycle-heartbeat` line for fifteen minutes | nobody is driving the rounds right now |

There is one channel: the alert Telegram bot, the same one the worker uses. The
token and the chat come from `TELEGRAM_ERROR_BOT_TOKEN` and
`TELEGRAM_ERROR_CHAT_ID` and are not in this repository.

The heartbeat and the stuck-round detector live in
`workers/lottery_phase_worker.py` (`_log_lifecycle_heartbeat`). A round's status
sits in the database where nothing outside can see it, so the worker has to say
it is stuck itself. The complaint repeats at most once an hour per round.
