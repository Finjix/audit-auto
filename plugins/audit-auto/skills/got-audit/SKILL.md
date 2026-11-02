---
name: got-audit
description: "Review GOT ad material, the videos, images or zips the user sends, against GOT's review spec. GOT has no fixed spec yet, so this means the dynamic spec collected from GOT's review groups. Reply with the table of 级别 / 位置 / 问题 / 怎么改 for each file (审片 / 审素材 / 审核视频 / 送审前检查). Only for material the user has said is GOT's: when they have not said which project it is (GOF or GOT), ask before anything else."
---

# GOT 审片 (review GOT ad material)

Talk to the user in their language (Chinese unless they write otherwise).

`audit` = `node <skill>/../../server/dist/audit.mjs` (`<skill>` = this skill's directory; Node.js 24+). It prints progress lines while it works and ends with one line of JSON. Exit code 2 means it refused or failed (`{"status":"blocked","reason":…}`).

## 1. Which project

This skill reviews GOT material only. Go on only when the user has said in this conversation that the material is GOT's. If they have not said which project it is, ask one short question, 「这是 GOF 还是 GOT 的素材？」, and stop there. Do not guess from file names or content. GOF material goes to the gof-audit skill.

## 2. What to review

The files the user sent: the attachment list in their message gives each path (under `input/`). Videos, images, or zips of them. Nothing sent yet: ask for the file. A folder cannot be received: ask for a zip. Files sent earlier in the conversation count when the user refers to them.

## 3. Review

`audit review --project GOT --file <path> [--file <path>]… [--note "<text>"]`

- One `--file` per file, in the order the user sent them. A zip is unpacked and every video and image in it is reviewed.
- `--note`: only what the user said about these files that helps the review (what kind of material it is, where its B part starts, what to look at), in their words. Leave it out otherwise.
- A video takes about a minute (several are reviewed two at a time). Say nothing while it runs; wait until it ends.

GOT's fixed spec is still a placeholder ([references/rules.md](references/rules.md)), so the review applies GOT's dynamic spec alone. While that is empty too, `review` refuses, and its `reason` says what to do: add the bot to GOT's review group and @ it there with 「监听本群更新审片规范」 (the dynamic-rules skill). Relay it as it is.

## 4. Answer

- `status: done`: reply with `markdown` exactly as it is: for each file, the 级别 / 位置 / 问题 / 怎么改 table. Keep it a Markdown table: do not shorten, reorder, merge or reword it, and add no findings of your own. If the output you read was cut off, read `result_file` (as UTF-8) and reply with that. No introduction, no closing remarks.
- `status: failed` (no file could be reviewed) or `blocked`: tell the user why (`reason`, or the `markdown`, which says why for each file) in one or two sentences.

Follow-up questions about a finding: answer from the review (`result_file`, and the `.json` next to it, which holds every transcribed line) and from GOT's dynamic spec (`audit rules show --project GOT`, whose `markdown` is the spec; no file is written). A corrected file sent again is a new review. When the user says a finding is wrong, the lasting fix is a clear ruling in GOT's review group, which the dynamic spec picks up.
