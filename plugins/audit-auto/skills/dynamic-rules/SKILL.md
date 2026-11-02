---
name: dynamic-rules
description: "The dynamic review spec (动态审片规范) the bot builds from a project's review-group chat; gof-audit and got-audit apply it together with the fixed spec. Use when someone in a group @-mentions the bot with 「监听本群更新审片规范」 or otherwise asks it to watch this group for review rules; to stop listening (「停止监听本群」); to update the spec now; to show or send the current dynamic spec of GOF or GOT; to list the groups listened to; or to delete a wrong rule."
---

# 动态审片规范 (dynamic review spec)

Talk to the user in their language (Chinese unless they write otherwise).

`audit` = `node <skill>/../../server/dist/audit.mjs` (`<skill>` = this skill's directory; Node.js 24+). It prints progress lines while it works and ends with one line of JSON. Exit code 2 means refused (`{"status":"blocked","reason":…}`): tell the user `reason`.

How it works: once the bot listens to a group, it reads the group's chat (the history at once, then every hour what is new) and turns the review rulings in it into rules of the project's dynamic spec. Rulings are platform rejections and their reasons (screenshots included), reviewers' 「X 不能用」「Y 可以用了」, and corrections. Every review of that project applies the dynamic spec together with the fixed spec; where they disagree, the dynamic one wins, being newer. A rule changes where it came from: a new ruling in the group updates or withdraws it at the next hourly reading.

The host tells the command line which chat the message came from; there is no chat argument.

## Start listening: 「监听本群更新审片规范」

1. Only in a group chat. In a private chat, tell the user to add the bot to the project's review group and @ it there with 「监听本群更新审片规范」.
2. A group's rules are for one project. Go on only when the user has said which (GOF / 无尽冬日, or GOT); otherwise ask 「这个群是 GOF 还是 GOT 的审核群？」 and stop.
3. `audit rules watch --project GOF|GOT [--since YYYY-MM-DD]` reads the last 180 days of the group's chat. Pass `--since` when the user says where to start (「从 9 月 1 号开始」, 「最近一个月」: work out the date). A busy group can take several minutes; wait until it ends.
4. Then `audit rules show --project <P> --output 动态审片规范-<P>.md` (in the working directory, so the file goes to the user), and reply in a few sentences, linking the `file` it returns (when that name is taken it writes `… (2).md`; link the one returned):
   - the bot listens to this group for <P> from now on and re-reads it every hour;
   - how many messages it read (`read`) and how many rules the dynamic spec has (`rules`, of which `added` are new);
   - reviews of <P> use it from now on.
   - `already: true`: the group was already being listened to; say so, with the same facts.
   - `pending: true`: the history was too long to finish now (a reading stops after about 15 minutes); the rest is read over the next hours.
   - `error`: the group is registered but reading it failed: tell the user `error` (a missing permission is for an administrator to fix). It is tried again every hour.

## Other requests

- Stop listening (「停止监听本群」): `audit rules unwatch`, in that group. The rules already collected stay in the dynamic spec.
- Update now (「现在更新一下规范」): `audit rules sync --here` in a group being listened to (`audit rules sync` without `--here` updates every group). For each group in `groups`: what changed (`added` / `updated` / `removed`), or that nothing did; its `error` if it has one (that group was not read: say why); `pending: true` means it is not read to the end yet and the rest follows within the hour. `status: failed` means no group could be read: give the errors.
- Show the dynamic spec (「看看 GOF 的动态规范」): `audit rules show --project <P> --output 动态审片规范-<P>.md`, link the `file` it returns, and say how many rules it has and when it was last updated. When the user has not named the project and this group is not listened to for one (`audit rules status` → `here`), ask GOF or GOT. To read the spec yourself (to answer a question about one rule, say), leave out `--output`: the Markdown comes back in `markdown` and no file is written.
- Which groups are listened to: `audit rules status`. `here` is this chat's project (null: not listened to), and the group entry with `here: true` is this chat. Give each group's project, since when, when it was last read, any `error`, and any `skipped` stretches of messages (they could not be turned into rules: give their time range and reason). Call the current chat 「本群」 and the others 「另一个群」; never show chat ids.
- Delete a wrong rule (「删掉 D3」): `audit rules remove --project <P> --id D3 [--id …]`, only for rules the user explicitly asked to delete. If they describe a rule without its id, show the spec first and confirm which one. Add that if the group's chat still says otherwise, a later reading may add it again: the lasting fix is a clear ruling in the group.
- Reviewing material is gof-audit's and got-audit's.
