# Security

This software reads a private message store, sends messages as a real account,
runs a model with tools, and on the sending side requires System Integrity
Protection to be disabled. Take that seriously before running it, and please
take it seriously when reporting.

## Reporting a vulnerability

Do not open a public issue for anything that could be used against a running
deployment. Use GitHub's private vulnerability reporting on this repository,
or email the maintainer at the address on their GitHub profile.

Include what you found, how to reproduce it, and what you think the impact is.
You will get an acknowledgement within a few days. This is a one person
project; there is no security team and no bounty.

## What counts

- A way for an inbound message to make the assistant act outside its
  conversation: send to someone else, read another person's memory, reach
  files outside the sandbox, or spend money it should not.
- A way for a non allowlisted sender to be admitted, or for a guest to reach
  tools guests should not have.
- A way to reach the operator dashboard without the PIN, or a person's portal
  without their token.
- A send that lands in the wrong chat while reporting success.
- A secret that reaches the repository, the logs or a public page.

## What is out of scope

- The consequences of disabling SIP. That is documented in
  [docs/private-api.md](docs/private-api.md) as a system wide decision the
  operator makes.
- Prompt injection that only changes the tone or content of a reply within the
  same conversation. The model reading untrusted text is the design.
- Issues in the model providers, Twilio, Stripe, Cloudflare or Apple's
  software.

## Hardening you should do

- Keep the DM allowlist non empty.
- Run it on a Mac that does nothing else.
- Set an operator handle so alerts reach you.
- Leave the trading integration off unless you have read its risk module.
- Back up `persona/` and `data/` somewhere the Mac is not.
