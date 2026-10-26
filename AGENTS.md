# AGENTS.md

Working rules for contributors and coding agents in this repository. They restate the
Paseo plugin requirements we must follow when developing, reviewing, and releasing.

## References

- Plugin quickstart: https://paseo.sh/docs/plugins
- Plugin reference: https://paseo.sh/docs/plugins/reference
- Publishing guide: https://paseo.sh/docs/plugins/publishing
- Registry review policy: https://github.com/getpaseo/plugins/blob/main/REVIEW.md

## Compliance

- Keep the standard plugin layout: `paseo-plugin.json`, `index.client.tsx`,
  `index.server.ts`, `client/`, `server/`, `shared/`, with a committed lockfile.
- Manifest paths are relative, use forward slashes, and must not contain `..` segments.
  Keep `requirements.paseo` accurate and the listed entry files present.
- Follow the plugin SDK contracts: client code must not reach into daemon-only APIs, and
  daemon code must not depend on the UI. Client and daemon code communicate only through
  the schema-validated RPC contracts in `shared/contracts.ts`.
- Dependencies must stay minimal and resolve through the committed lockfile. Any build or
  lifecycle script must have an understandable purpose and no hidden side effects.
- Registry review reads the pinned artifact without executing it; everything needed to
  understand the plugin must be inside the repository.

## Security

- Agent sessions and transcripts are private user data. The plugin reads timelines and
  conversation context through the local Paseo daemon only, and never transmits them to
  any service of its own.
- Side-chat content (questions, context snapshots, tool results) is sent to the model
  provider the user configured in Paseo for the side agent, exactly like a normal Paseo
  session, and remote images in side-chat messages load on the client directly from
  their HTTP(S) URLs. Beyond that there are no other network destinations, no telemetry,
  and no hidden calls.
- Never log or echo prompts, transcripts, tool output, or context snapshots. Server logs
  may include ids, thread metadata, and lifecycle events only.
- Helper agents (thread titles, experimental cancel) are short-lived, run on the user's
  configured providers, and are archived as soon as they finish.
- The thread registry stays in `~/.paseo/plugin-data/paseo-bytheway/` and contains thread
  metadata only; Q&A transcripts stay in Paseo's own agent timelines.
- Development scripts connect to the local daemon with the credential supplied by the
  user's environment; never print, log, or commit credentials or key material.

## Data sanitization

- Everything committed must be desensitized: no real names, hostnames, IP addresses,
  account handles, project names, workspace paths, tokens, or customer data in code,
  comments, docs, fixtures, examples, screenshots, or commit messages.
- Use obvious placeholders such as `<host>`, `user@example.com`, `acme-project`, `12345678`.
- Screenshots and media: agents must never capture, generate, edit, replace, or push
  images themselves. Only screenshots supplied by the author may be committed, and only
  after the author confirms they are desensitized. Never push an image change the author
  did not provide.

## Code safety

- Thread registry writes are atomic (temp file + rename) and bounded; transcripts are
  never copied into plugin storage.
- Validate and clamp external input (settings, model ids, thread ids); keep error messages
  useful without echoing conversation content.
- Permission handling, cancel behavior, or data-access changes must update `OVERVIEW.md`
  in the same change.

## Keeping docs in sync

Feature changes must update the user-facing documents in the same change:

- `README.md`: feature list, commands, and development notes.
- `OVERVIEW.md`: capabilities, settings, permissions, and data access.
- `paseo-plugin.json`: description, media, icon, and requirements.

A release is not ready while these documents still describe older behavior.

## Publishing and releases

The registry at https://github.com/getpaseo/plugins pins one exact commit of this
repository, and that pinned artifact is what users install.

1. Push the finished change to `main` after the checklist below passes.
2. The first listing goes through the registry submission form. After a listing exists,
   request updates with a direct pull request editing `plugins/casonmo/bytheway.json`:
   bump both `artifact.commit` and `repository.commit` to the new `main` hash (and update
   `listing.media` raw URLs for any media change). Do not open a submission issue for
   updates — the direct PR path is validated and merged automatically by the registry bot.
3. The registry bot verifies the pinned commit, runs the trusted registry validation, and
   merges. Approved listings appear on paseo.sh/plugins; no tag is required.
4. After merge, confirm the listing installs the new pin.

Checklist before pushing:

- `npm run typecheck`, `npm test`, and `npm run smoke` pass.
- Grep the change for secrets and real identifiers; confirm none.
- README, OVERVIEW, and the manifest are updated together (see above).
- Bump `package.json` version for user-visible changes.
- Screenshots are supplied by the author, never captured or committed by agents; ask the
  author to provide the desensitized screenshot instead.
