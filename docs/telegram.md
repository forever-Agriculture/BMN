# Telegram

BMN can message you on Telegram when a session needs you, and take your reply back to that
session. It uses a bot you create and own. It is off by default.

## What it does

- When an agent asks for your attention (`bmn ask`, `bmn handoff`, or a Claude Code, Codex or OpenCode hook), the bot
  sends you the request while you are away from the desk and the request is still unanswered. If
  BMN cannot read idle time, it treats you as away. Claude sessions connected to Remote Control
  are left to the Claude app. Optionally it also tells you when a session's process exits while you
  are away. See
  [agent-control.md](agent-control.md#agent-hooks-needs-you-for-claude-code-codex-and-opencode).
- Reply to that message in Telegram. By default the reply is saved as a **draft** for that exact
  session, and you send it from the Files panel. If you turn on **Type replies into the session and
  press Enter**, the reply is typed into the session directly. Replies to handoff pages always stay
  drafts for the source session.
- A message that is not a reply to a notification gets a short answer asking you to reply to one,
  so text never lands in whichever session happens to be focused.
- It cannot deliver handoffs or manage sessions remotely; inspect and deliver handoffs in BMN's Files
  panel.

## Tap to answer

A page is a card: the session, the agent (with the model maker's flag when BMN has seen it), the
question in bold and the options numbered, with one button per option. Tap one and the card says
**Sending…** at once; BMN then types or posts exactly that answer into the dialog that asked, and
edits the same card to say what happened:

- **✓ Sent: JWT**, **✓ Allowed once** or **✓ Denied** only when the agent itself reported that
  answer back.
- **⚠ Sent — not confirmed, check the laptop.** when it was sent but nothing confirmed it; BMN never
  sends it twice. A late confirmation still turns it into ✓.
- **Nothing was sent: …** with the reason (the dialog changed, it is not on the screen, …) and fresh
  buttons while the question is still open. **OpenCode rejected the answer; nothing was applied.**
  does the same, even after the card first said not confirmed.
- **Answered at the laptop.** or **No longer open.** when it ended some other way; the buttons go.

Several questions in one dialog are shown one at a time on the same card, earlier answers quoted
above; nothing is sent until the last one. From the second question on, **‹ Back** reopens the one
before with its choice marked ●; it changes only the card, because nothing has been sent yet.

A multi-select question shows one toggle per option (`○ 1 · Label`, `● 1 · Label` once chosen) and
repeats the choice in full as **Chosen: …**; toggling only edits the card. Once something is chosen,
**Send N selected** (or **Next · N selected** before the last question) goes on. **Other…** answers in
your own words: tap it, then reply to the card; **‹ Options** goes back with your toggles intact. The
reply is sent as one line (line breaks and control characters become spaces), clipped to 2,000
characters, and never becomes a draft or a prompt. A reply to a card that offers Other… before you
tapped it is refused with **Tap Other… first**; while its answer is on its way, or once it is done, a
reply to it is refused too, never turned into a draft. A reply made only of frame glyphs such as `│`
or `✔` cannot be checked on a Claude or Codex screen and is refused. A new version of an open request edits its card instead
of sending another. Uncertain, partial and refused answers also get a short reply, so the phone
sounds. If Telegram does not take the final edit, BMN tries again after about 10 s, 1 min and 5 min
and never sends the answer twice; a card still unfinished at the next start is finished then. After a
BMN restart, cards still showing buttons say **BMN restarted — answer at the laptop.**

Buttons are single-use and bound to that request, its version, the dialog on screen and the process
that asked; an old or copied button changes nothing and says so. When a request changes, its old
buttons stop working before the new card is drawn. Only the allowed chat and user can
tap.

What can be tapped (see [remote-answers.md](remote-answers.md) for how each is verified):

| Shape | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| One question, one choice | buttons | buttons (Plan mode) | buttons |
| Several questions | buttons | buttons | buttons |
| Permission | **Allow once** / **Deny** for `Bash` | answer at the laptop | **Allow once** / **Deny** (Deny only when it is the only permission waiting) |
| Multi-select | toggles | — (Codex has none) | toggles |
| Other… (your own words) | on every question | on every question, sent as "None of the above" with your text as its note | unless the question turned it off |
| Back | buttons | buttons | buttons |
| Subagent and sandbox prompts | answer at the laptop | answer at the laptop | answer at the laptop |

Permission buttons appear only after you tick **Answer permission prompts from Telegram** in
Preferences → Telegram (off by default). They answer the exact prompt on screen, once; there is no
"always allow". A command too long to show whole (over 3,000 characters) gets no buttons: the card
says **The command is too long to show here. Answer at the laptop.** With the setting off, a permission card ends **Answer this at the laptop.**

Cards without buttons are drawn the same way and end **No buttons for this kind yet. Answer at the
laptop.** A text reply to a dialog without Other… stays a draft even with direct typing on, because a
typed line cannot pick an option. If Telegram refuses a card's formatting, it is resent once as plain text.

## Setup

1. In Telegram, talk to [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token.
2. Find your chat ID: send any message to your new bot, then open
   `https://api.telegram.org/bot<token>/getUpdates` in a browser and read `message.chat.id`. For a
   private chat it is also your user ID.
3. In BMN, open **Preferences → Telegram**:
   - paste the **Bot token** and save it;
   - enter the **Allowed chat ID** (and, for a group chat, the **Allowed user ID**);
   - choose **Notify on**: Needs-you requests, or Needs-you requests and session exits;
   - optionally tick **Answer permission prompts from Telegram** to get Allow once / Deny buttons;
   - tick **Enabled** and save.
4. Check the status line shows it polling, then press **Send test message**.
5. For buttons, the agents must report their dialogs to BMN. Run `bmn hooks check`; if any entry
   says `missing`, run `bmn hooks install claude` (and `codex`, `opencode`); Codex must then trust
   the new entries once with `/hooks`. Without them a question never reaches your phone as a card,
   and a permission arrives only as a plain "needs your permission" message.

## Security

- The token is stored in `~/.config/bmn/telegram-bot.token` with mode `600`. It is never
  shown again in the interface (only a mask) and is removed from error messages.
- Only updates from the allowed chat are processed. Without an allowed user ID, only a private chat
  is accepted; with one, only that user's messages and taps are. Everything else is counted as
  rejected and ignored.
- A tap can only choose among the buttons BMN drew for one open request. Nothing an agent can reach
  (the control socket or the `bmn` CLI) can create or change an answer.
- The connector uses outbound long polling. Nothing listens for incoming connections.
- Text that looks like a secret is hidden before BMN sends it, as `[secret hidden]`: `sk-` keys
  (`sk-ant-`, `sk-proj-`), AWS access key ids, `Bearer` tokens, GitHub, Slack and Google API keys,
  JWTs, PEM private keys, BMN's own session tokens, and the value of an `api_key`, `apikey`, `token`,
  `secret`, `password` or `passwd` assignment of 8 or more characters (the name stays). This covers
  every card, option label, button and toast. A card that hid something ends with "Some text looked
  like a secret and was hidden. The full text is on the laptop." A key is hidden wherever its shape
  appears, even run into other text; the `sk-` shape also takes a hyphenated word ending in `sk` with a
  long slug (`task-add-…`), which is hidden too. A permission whose command had part hidden, or held invisible characters, gets no
  Allow button: answer it at the laptop. A handoff preview is never cut through a secret. A tapped option still answers that option.
  Only what leaves for Telegram is masked; the terminal, saved output, Needs you, Files and handoff
  drafts keep the exact text. Invisible and direction-changing characters are removed as well.

## One program per bot

Telegram lets only one program poll a bot for updates at a time. If another bot script, bridge or
second computer uses the same token, both get `409 Conflict` errors and messages go to whichever
wins. BMN takes a lock so it never runs two connectors on one token itself, but it cannot
see other programs: use a separate bot for BMN, or stop the other poller.

Sending messages does not conflict, so scripts that only *send* through the same bot keep working.
