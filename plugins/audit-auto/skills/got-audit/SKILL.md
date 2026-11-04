---
name: got-audit
description: "Review GOT ad material, the videos, images or zips the user sends, against GOT's review spec: the fixed spec in this skill (from 《GOT 广告素材审核规则》) plus the dynamic spec collected from GOT's review groups. Reply with the table of 级别 / 位置 / 问题 / 怎么改 for each file (审片 / 审素材 / 审核视频 / 送审前检查). Only for material the user has said is GOT's: when they have not said which project it is (GOF or GOT), ask before anything else."
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
- What the user says about the plan (方案) for this material (how many towers, routes, how long) goes in `--note` too: the fixed spec checks such numbers against the plan only when the review is told it.

## 4. Answer

- `status: done`: reply with `markdown` exactly as it is: for each file, the 级别 / 位置 / 问题 / 怎么改 table. Keep it a Markdown table: do not shorten, reorder, merge or reword it, and add no findings of your own. If the output you read was cut off, read `result_file` (as UTF-8) and reply with that. No introduction, no closing remarks.
- `status: failed` (no file could be reviewed) or `blocked`: tell the user why (`reason`, or the `markdown`, which says why for each file) in one or two sentences.

Follow-up questions about a finding: answer from the review (`result_file`, and the `.json` next to it, which holds every transcribed line) and from the spec: the fixed one in [references/rules.md](references/rules.md), the dynamic one from `audit rules show --project GOT` (its `markdown`; no file is written). A corrected file sent again is a new review. The review applies this skill's fixed spec together with GOT's dynamic spec (see the dynamic-rules skill); when the user says a finding is wrong, the lasting fix is a clear ruling in GOT's review group, which the dynamic spec picks up.
