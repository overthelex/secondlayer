# attorney_crm

Internal CRM at https://attorney.legal.org.ua/ for selling legal.org.ua to advocates.
Lists active advocates from the НААУ registry (`opendata_advocates`), shows practice
areas derived from ЄДРСР plus manual tags, keeps call/letter notes and a "today" page.

- Design: `docs/superpowers/specs/2026-11-07-attorney-crm-design.md`
- Runs as `attorney-crm-local` in `deployment/docker-compose.local.yml` on cthulhu,
  behind nginx (`deployment/nginx/conf.d/aws-migrated.conf`).
- Tables `attorney_crm_*` are created by the service on boot from `sql/*.sql`.
- Secret: `ATTORNEY_CRM_SESSION_SECRET` in `.env.local` on the host.

## Operate

```bash
# create or reset a user (inside the container)
docker exec attorney-crm-local node dist/cli.js set-password vladimir@legal.org.ua '<password>' 'Володимир'

# one-off ЄДРСР practice backfill (tmux on cthulhu), resumable
scripts/attorney-crm/derive-practices.sh 2024 2025 2026
SELECT * FROM attorney_crm_practice_progress;
```

## Develop

```bash
cd attorney_crm && npm ci && npm test && npm run build
DATABASE_URL=postgres://... ATTORNEY_CRM_SESSION_SECRET=dev npm run dev
```
