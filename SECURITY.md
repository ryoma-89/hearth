# Security policy / セキュリティについて

## Scope and threat model

Hearth lets a language model run commands and edit files on your machine. Its defenses are layered:

1. **DeepSeek Harness Windows ACL sandbox** (workspace-write) confines writes of spawned processes to the task workspace. This is the enforcing boundary.
2. **Hearth policy** (`src/plugins/policy.ts`): realpath-based workspace path checks (symlinks, junctions, `..`, UNC, alternate data streams, device names), protected paths, PowerShell-AST command classification, backups before deletes/overwrites, audit log. Dangerous commands are refused in unattended runs; there is no silent auto-approval.
3. **Daemon**: listens on loopback only, bearer token for CLI/plugins, one-time login codes + HttpOnly SameSite=Strict cookies + Host/Origin/CSRF checks for the Web GUI, strict CSP.
4. **Secrets**: API keys are never stored in config files (environment variable or Windows DPAPI).

Known limits are listed in [docs/known-issues.md](docs/known-issues.md) (e.g. hard links, reads outside the workspace from `python_run` code, prompt-level mitigations that a model may ignore).

**Do not expose the daemon to a network.** Remote access (Tailscale, user management) is not implemented; the config validator rejects non-loopback hosts.

## Reporting a vulnerability

Please report security issues privately through GitHub's "Report a vulnerability" (Security Advisories) on this repository rather than in public issues. Include the version/commit, steps to reproduce, and impact.

---

セキュリティ上の問題は、公開 Issue ではなく、このリポジトリの GitHub「Report a vulnerability」（Security Advisories）から非公開で報告してください。デーモンをネットワークに公開しないでください（ループバック限定の設計です）。
