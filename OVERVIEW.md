# ByTheWay

Side chats for any Paseo agent session: ask questions or run small side tasks while the
main session keeps working, and nothing is written to the main transcript.

## How it works

Each side thread is backed by a temporary agent in the same workspace:

- When a thread starts (from the panel or the `/btw`-family commands), the plugin reads
  the main session's recent conversation as a first-turn context snapshot and sends the
  question to a side agent;
- The panel subscribes directly to the side agent's timeline and streams text, thinking,
  tool calls, todos, permission requests, and per-turn usage live;
- By default the side agent is linked to the main session: it reads the latest progress
  on demand through Paseo's built-in tools. When tool injection is unavailable, the
  plugin falls back to passive sync (incremental context attached to each message);
- Transcripts live in Paseo's own agent timelines. The plugin stores only a thread
  registry (ids, titles, status) on the local machine and never copies Q&A content.

## Usage

- `/btw <question>` continues the current side thread (or starts one); a bare `/btw` just
  opens the panel without creating anything; `/btw-new <question>` starts a new one;
- `/side <task>` and `/side-new <task>` are the same in Build mode (tasks allowed);
- `/fork [prompt]` clones the current session transcript into a new parallel agent;
- The Command Center can open the ByTheWay panel and its settings;
- The threads dropdown can copy a thread's agent id to the clipboard (for handing the
  agent to another tool);
- Each thread tab has a ✕ that archives that thread in one click;
- The bottom hint row links to this repository's GitHub issue form ("Issues & feature
  requests") — it opens in your system browser and only when you click it;
- On desktop the panel composer sends with Enter and inserts a newline with Shift+Enter
  (same as the main Paseo composer);
- While a side chat is answering, the composer shows only Stop (when idle it shows only
  Send); pressing Enter still interrupts the current answer and starts a fresh turn with
  the new message (a toast confirms);
- Assistant text uses the host Markdown renderer; the UI language follows the Paseo app language;
- The panel shows a banner when a newer plugin version is available on GitHub main, including
  the required Paseo version (apply with `paseo plugin update paseo-bytheway` in a terminal).

## Settings

Settings → Plugins → ByTheWay 侧聊:

- Default mode (Chat / Build) and default model (follow the main session or fixed
  provider/model); new threads also inherit the main session's thinking level and
  provider feature toggles (e.g. OpenCode auto-accept) when the model/provider match
- New threads can pick any provider; existing threads switch models in place within their own provider only
- First-turn snapshot depth, action digest, context fallback
- Attach side agents to the main session as children
- AI thread titles and the title-generation model
- Permission policy (follow the main session / ask + auto-deny timeout / auto-allow read-only / deny all)
- Concurrency limits (Chat / Build / total) and the experimental cancel switch

No account or extra keys are required; the plugin reuses the agent providers configured
in Paseo. Requires Paseo 0.13.0-beta.1 or later. The daemon runs on any platform Paseo supports,
and the interface works on desktop, web, and mobile clients.

## Data and permissions

- Reads: main-session and side-agent timelines through the local Paseo daemon (for
  context assembly and UI display);
- Writes: the local plugin data directory `~/.paseo/plugin-data/paseo-bytheway/`
  (thread registry only);
- Network: remote images in side-chat messages load directly from their HTTP(S) URLs on
  the client, so the image host receives that request and the client's network address.
  Side-chat questions, context snapshots, and tool results are sent to the model provider
  you configured in Paseo, exactly like a normal Paseo session. When the panel opens, the
  plugin fetches `package.json` / `paseo-plugin.json` from this repository's main branch on
  `raw.githubusercontent.com` to check for updates (version metadata only; no session data
  is uploaded). The feedback link in the panel opens this repository's GitHub issue form
  in your external browser, only when you click it.
- Permissions: new side agents inherit the main session's thinking level and provider
  feature toggles (for example OpenCode's auto-accept) at creation, so permission
  behaviour matches the main session by default. Tool permission requests from side
  agents appear inline in the panel for approval or denial; question-type requests render
  as a step-by-step form (one question per screen, single-select advances automatically,
  all answers submitted once at the last step). By default the plugin leaves permission
  handling to Paseo itself ("follow"), so side agents behave like the main session;
  optional plugin policies can auto-allow read-only requests, deny all, or auto-deny
  unanswered requests after the configured tiered timeout;
- Stop: cancellation is requested through Paseo's tools first; if it does not take
  effect, the panel points to the native tab to stop the agent there.

## Known limits

- Threads are bound to the daemon and main session that created them. If the main session
  is archived, threads are marked stopped and can be rebuilt to continue;
- Existing threads switch models in place within their own provider (the provider is
  fixed when the thread is created; start a new thread to use another provider).
  Switching Chat/Build mode also switches in place: the thread's agent mode is switched
  for real (via a short-lived helper agent calling Paseo's set_agent_mode), and the next
  message carries a mode-switch note; if the switch fails the message is not sent and the
  panel shows why;
- AI titles, the experimental cancel, and model/mode switching create a short-lived helper
  agent that archives itself when done (it may appear briefly in the agent list);
- Running side chats are limited by the configured concurrency caps; requests beyond the
  cap are rejected with a hint.
