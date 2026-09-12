# `@opalinehq/cli`

The canonical Opaline CLI package for Claude Code and OpenAI Codex session
analytics.

```bash
npm install --global @opalinehq/cli
opaline login
opaline upload
opaline doctor
```

`opaline upload` groups discovered worktrees by repository, saves the selected
repositories for automatic upload, and sends only sessions the server does not
already have. `opaline enable` remains available to enable the current
repository directly.

The CLI keeps using the existing `~/.rudel` state directory so upgrades do not
require another login. Its production API is `https://opaline.so`.

For commands, configuration, troubleshooting, and the full security/data
handling disclosure, see the
[repository README](https://github.com/opalinehq/cli#readme).

Important: session transcripts are uploaded. Known-pattern secret filtering is
best-effort and cannot guarantee that every sensitive value is removed.
Capable servers use direct multipart object-storage uploads after filtering;
older servers continue to use the legacy ingest endpoint.
