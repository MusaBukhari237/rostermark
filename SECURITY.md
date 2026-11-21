# Security policy

Attendance data is personal data. If you find a vulnerability, please do not open a public issue.
Use GitHub's **Report a vulnerability** button on the Security tab of this repository instead.
We aim to reply within a week.

When you self-host:

- Serve the app over HTTPS only (put it behind a reverse proxy such as Caddy, Traefik or Nginx).
- Back up the data volume regularly.
- Change the first admin password right after setup, and remove `ADMIN_PASSWORD` from your environment.
- Do not enable `DEMO=1` on an instance that holds real data.
