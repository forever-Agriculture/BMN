# Telegram

BMN can message you on Telegram when a session needs you, and take your reply back to that
session. It uses a bot you create and own. It is off by default.

## What it does

- When an agent asks for your attention (`bmn ask`, `bmn handoff`, or a Claude Code, Codex or OpenCode hook), the bot
  sends you the request while you are away from the desk and the request is still unanswered. If
  BMN cannot read idle time, it treats you as away. On Linux, Claude sessions connected to Remote
  Control are left to the Claude app; that detection is unavailable on macOS. Optionally it
  also tells you when a session's process exits while you are away. See
  [agent-control.md](agent-control.md#agent-hooks-needs-you-for-claude-code-codex-and-opencode).
- Reply to that message in Telegram. By default the reply is saved as a **draft** for that exact
  session, and you send it from the Files panel. If you turn on **Type replies into the session and
  press Enter**, the reply is typed into the session directly. Replies to handoff pages always stay
  drafts for the source session.
- A message that is not a reply to a notification gets a short answer asking you to reply to one,
  so text never lands in whichever session happens to be focused.
- It cannot approve permission prompts, deliver handoffs or manage sessions remotely. Answer prompts
  in the terminal; inspect and deliver handoffs in BMN's Files panel.

## Setup

1. In Telegram, talk to [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token.
2. Find your chat ID: send any message to your new bot, then open
   `https://api.telegram.org/bot<token>/getUpdates` in a browser and read `message.chat.id`. For a
   private chat it is also your user ID.
3. In BMN, open **Preferences → Telegram**:
   - paste the **Bot token** and save it;
   - enter the **Allowed chat ID** (and, for a group chat, the **Allowed user ID**);
   - choose **Notify on**: Needs-you requests, or Needs-you requests and session exits;
   - tick **Enabled** and save.
4. Check the status line shows it polling, then press **Send test message**.

## Security

- The token is stored in `~/.config/bmn/telegram-bot.token` with mode `600`. It is never
  shown again in the interface (only a mask) and is removed from error messages.
- Only updates from the allowed chat are processed. Without an allowed user ID, only a private chat
  is accepted; with one, only that user's messages are. Everything else is counted as rejected and
  ignored.
- The connector uses outbound long polling. Nothing listens for incoming connections.

## One program per bot

Telegram lets only one program poll a bot for updates at a time. If another bot script, bridge or
second computer uses the same token, both get `409 Conflict` errors and messages go to whichever
wins. BMN takes a lock so it never runs two connectors on one token itself, but it cannot
see other programs: use a separate bot for BMN, or stop the other poller.

Sending messages does not conflict, so scripts that only *send* through the same bot keep working.
