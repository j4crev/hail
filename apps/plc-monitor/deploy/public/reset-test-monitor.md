# Archive and restart a dedicated pre-launch monitor

Use this procedure only when **every identity watched by this monitor is being
retired from monitoring**, for example while replacing a disposable test provider.
It is not a way to remove one customer's account from a shared monitor. Inventory
the watched DIDs first; stop if any must retain coverage. This procedure is for an
operator's privileged console. The restricted operations wrapper intentionally
has no reset command; do not expand its permissions to perform a reset.

The result is an empty monitor database under its existing name, `monitor`.
The old database is renamed and retained with connections disabled. This preserves
the current PostgreSQL version, volume, Compose project, overlays, database URL,
and installed tools. No volume is deleted and no PLC operations are published.
Old identities and their signed history remain at `plc.directory`. Archived
monitor records are historical evidence, not current monitoring coverage.

## 1. Inventory and back up

On the monitor host, identify the actual containers and supply their names:

```bash
set -euo pipefail
docker ps --format '{{.Names}} {{.Image}}'
read -r -p 'Monitor worker container: ' monitor_container
read -r -p 'Monitor PostgreSQL container: ' monitor_db_container
read -r -p 'Absolute private backup directory: ' monitor_backup_dir
install -d -m 700 "$monitor_backup_dir"
umask 077
monitor_archive="monitor_retired_$(date -u +%Y%m%d_%H%M%S)"
printf 'Archive database name: %s\n' "$monitor_archive"
docker exec "$monitor_db_container" psql -X -v ON_ERROR_STOP=1 -U monitor -d monitor \
  -c 'SELECT did,expected_cid,stopped_at FROM monitored_dids ORDER BY did'
```

Review the complete DID list, including stopped watches. Keep the recovery vaults
for any identities you may need to control later. A provider database reset does
not revoke their public identities or remove messages retained by other providers.

Pause new provider signup/enrollment, stop any separate poll/notify processes, and
schedule monitor heartbeat/backup maintenance so it is not mistaken for an outage.
Do not suppress unrelated provider or monitor alerts. Then stop this worker and
create an offline logical backup:

```bash
docker stop "$monitor_container"
docker exec "$monitor_db_container" pg_dump -U monitor -d monitor -Fc \
  > "$monitor_backup_dir/$monitor_archive.dump"
test -s "$monitor_backup_dir/$monitor_archive.dump"
docker exec -i "$monitor_db_container" pg_restore --list \
  < "$monitor_backup_dir/$monitor_archive.dump" > "$monitor_backup_dir/$monitor_archive.contents"
sha256sum "$monitor_backup_dir/$monitor_archive.dump" \
  > "$monitor_backup_dir/$monitor_archive.sha256"
```

Stop on any error. Verify a restore into a disposable database before proceeding;
a successful archive listing alone is not restore proof. Keep an encrypted
backup off-host. Separately preserve `secrets/monitor.pkcs8`, the private Compose
configuration and installed overlays. Never print the private key or service
secrets. Retaining the same monitor key keeps existing public-key pins valid;
rotating it is a separate change to all consumers and the alert receiver.

## 2. Archive the old database and create the empty replacement

Run only after the inventory and backup are accepted. The following assumes the
reference database name/owner `monitor`. Do not substitute another database
without checking its consumers. The connection is to the maintenance database
`postgres`, not the database being renamed.

```bash
docker exec -i "$monitor_db_container" psql -X -v ON_ERROR_STOP=1 \
  -U monitor -d postgres -v archive="$monitor_archive" <<'SQL'
SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = :'archive') AS archive_exists \gset
\if :archive_exists
  \echo 'Archive name already exists; stop and inspect the previous attempt.'
  \quit 1
\endif
SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = 'monitor') AS consumers_active \gset
\if :consumers_active
  \echo 'Database still has clients; stop them and retry without terminating unknown sessions.'
  \quit 1
\endif
ALTER DATABASE monitor ALLOW_CONNECTIONS false;
SELECT format('ALTER DATABASE monitor RENAME TO %I', :'archive') \gexec
CREATE DATABASE monitor OWNER monitor TEMPLATE template0;
SQL
```

These commands are deliberately not a transaction: PostgreSQL database creation
cannot run inside one. Stop on failure. If renaming failed, inspect `pg_database`
and re-enable connections to the original `monitor` database before restarting
its worker. If creation failed after renaming, the archive still exists; create
the empty replacement or reverse the rename. Do not repeatedly run the whole
block after a partial failure. Record the archive name outside the shell.

## 3. Configure and bootstrap the new monitor generation

Keep `MONITOR_ORIGIN` and the monitor signing key unless deliberately changing
operator identity. Set `MONITOR_ENROLLMENT_PROVIDER=https://svr.haili.app` for the
new Haili provider (or your own API origin). Update the **effective** protected
environment: on existing Haili installs, `/etc/hail-monitor-enrollment/enrollment.env`
may override the checkout's `.env`. Keep all PostgreSQL/image/enrollment overlays.
Coordinate any changed enrollment and email service secrets with their callers.

Recreate only the worker using the deployment's full Compose invocation; a plain
restart does not load changed environment. The startup migration builds empty
monitor tables. Existing installed tools continue using database `monitor`.
Check that it contains zero watched DIDs and zero queued alerts, then use the
[new-provider administrator ceremony](../../../server/deploy/standalone/README.md#first-administrator-vault-to-dashboard)
to enroll the new DID, deliver its enrollment alert and obtain an attestation.
Do not require healthy enrolled-DID coverage before there is a new enrollment;
a fresh monitor may be unhealthy until its first successful poll. After bootstrap,
verify coverage and notifications, and resume heartbeat/backup scheduling.

The separate Cloudflare alert receiver is **not reset** by this procedure. It
retains bound email destinations, deduplication records and operational state.
New signups use new DIDs and signup IDs, so they do not reuse those bindings.
Preserve replay-suppression records; bulk deletion could allow old signed alerts
to be delivered again. Retiring old bound email records, rotating receiver
secrets, or changing availability checks is a separate scoped receiver task. Keep the receiver's `SIGNUP_ORIGIN` on the
browser origin (`https://haili.app`); its provider-health URL may target
`https://svr.haili.app/health/ready` or the deliberately retained browser-host
health route.
Do not claim that a monitor database reset erased those external records.

## Recovery

Before new enrollments, stop the worker, disable connections to the new empty
`monitor` database, rename it to a distinct retained name, rename the recorded
archive back to `monitor`, and set `ALLOW_CONNECTIONS true`. Restore the old
provider-origin configuration before recreating the worker. Do not drop either
database. After new enrollments, both generations contain meaningful state: keep
both and plan reconciliation instead of silently rolling back active coverage.
The retained archives increase disk usage; remove them only under a separate,
explicit retention decision after verified backups.
