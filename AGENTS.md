# Instructions for agents

**This repository is PUBLIC.** Everyone can read what goes into it: each file, commit message,
branch, pull request, issue and comment. Git history keeps a value after a later commit removes it,
and GitHub keeps pull request commits after a force push.

## No personal information

Never put personal information into this repository. This includes:

- phone numbers, email addresses, postal addresses and postcodes;
- the names and details of family, friends, contacts and other private people;
- purchases, orders, receipts, payment and bank details, and account or customer IDs;
- the content of messages, calls, emails, voice notes and transcripts;
- machine and host names, LAN and Tailscale addresses, and the URLs of personal deployments;
- secrets: tokens, keys, passwords, cookies, auth folders, logs and raw captures (HAR files).

Use stand-ins in code, tests, comments and docs:

- phone numbers: Ofcom's drama range, +44 7700 900000 to +44 7700 900999;
- email addresses and URLs: `example.com`, `example.org` or a `.example` domain;
- people: invented first names (Sam, Ada, Grace);
- IP addresses: `192.0.2.0/24`, `198.51.100.0/24` and `203.0.113.0/24` (RFC 5737).

A real value belongs in the private project (its secrets and its config repo) or in the local
configuration of the computer that lends an integration. Code reads it at runtime, for example from
an environment variable.

Before each commit and each pull request, read the diff for real numbers, addresses, names and
identifiers. If personal information reaches GitHub, stop and tell the repository owner: removing it
from history needs a force push and a request to GitHub Support.
