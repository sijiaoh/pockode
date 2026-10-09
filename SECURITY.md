# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: go to the [Security tab](https://github.com/sijiaoh/pockode/security) and choose **Report a vulnerability**. Do not open a public issue.

Include what you found, how to reproduce it, and the Pockode version (`pockode -version`). You will get a reply in the advisory thread, and a fix ships in a regular [release](https://github.com/sijiaoh/pockode/releases).

Only the latest release is supported.

## Trust model

Pockode gives whoever holds the password full read/write access to your project and the ability to run AI agents on your machine. Keep that in mind when you deploy it:

- **One password, full access.** There are no user accounts or roles. Use a generated password, not one you use anywhere else.
- **The relay is a TLS-terminating hop.** Remote access goes phone → Pockode cloud relay → your machine, TLS on both legs. The relay decrypts traffic in between; it does not inspect, log or store content (see the [privacy policy](https://pockode.com/privacy)). Run with `-relay=false` if you do not want traffic to leave your network.
- **Direct LAN access is plain HTTP.** Connecting to `http://<LAN-IP>:<port>` encrypts nothing — not the password, not your code. Use it only on a network you trust; otherwise use the relay.

The full design is in [docs/code/authentication.md](docs/code/authentication.md).
