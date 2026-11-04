# Security policy

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button (Security tab), not as public issues. We aim to reply within a week.

## Threat model in short

- The dashboard is meant for your own network. Anyone who logs in is the admin and can run any command on the phone (that's what deploying an app is).
- Protect the password, and don't expose the dashboard to the internet without a strong password (or Cloudflare Access in front of it).
- Apps share the Termux user, so they're separated from other Android apps but not from each other.
