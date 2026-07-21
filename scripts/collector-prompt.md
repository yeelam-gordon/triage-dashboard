# Triage collector — data contract & prompt notes

Single source of truth for what the nightly triage collector must produce so the
dashboard (`index.html`) renders correctly. AGENTS.md references this file; keep
the two in sync. The collector itself may run on any machine (see AGENTS.md
"Delivery methods") — this file describes the **output contract**, not the host.

## Repos covered (6)

```
microsoft/intelligent-terminal
microsoft/PowerToys
microsoft/WSL
microsoft/wslg
microsoft/dynwinrt
microsoft/win-dev-skills
```

## Output files

- `data/latest.json` — summary + the **top deeply-triaged slice** of rows +
  per-repo `owed_list` summaries (with `owed_file` pointers).
- `data/owed/<owner>-<repo>.json` — each repo's **full owed backlog** (every
  open issue/PR as a lightweight row). Lazy-loaded when a repo tab is opened.
  PowerToys is ~7,400 rows / ~6.8 MB — this is expected.

## Fields the dashboard reads

The dashboard derives a lot **client-side** (see next section). Emit these inputs
and keep them stable. Two tiers of rows exist:

### Every owed row (lightweight — ALL ~9k rows)
Required: `repo`, `number`, `title`, `url`, `kind` (`issue`|`pr`).
Real GitHub signal: `labels[]`, `up` (👍 reactions), `comments`, `created_at`,
`updated_at`, `age_days`, `is_community`.
Baseline triage (drives the state pill + Run-agent action for the **whole**
backlog — do NOT drop these):
- Issues: `baseline_action` ∈ {`reply`, `request_info`, `label_only`,
  `reassess_stale`, `promote`, `escalate`, `no_action`, `await_author`},
  plus `baseline_glyph`, `baseline_text`, `baseline_reason`, `awaiting`,
  `triaged`, `fix_ready`, `build_candidate`.
- PRs: `baseline_action` ∈ {`review`, `wait_author`, `assign_reviewer`,
  `await_author_changes`}, plus `merge_state`, `review_decision`, `is_draft`.

### Deep-triaged slice (top-N — premium fields)
`next_action`, `next_action_reason`, `category`, `classification_type`,
`severity`, `sentiment`, `score`, `suggested_labels[]`, `suggested_reply`,
`suggested_owner`, `owner_kind`, `current_labels[]`, `priority_age_days`,
`days_awaiting`. PRs also: `pr_ci_rollup`, `pr_failing_jobs[]`, `pr_merge_state`,
`pr_review_decision`.

### Summary blocks
- `counts` — **set `backlog_open_issues` / `backlog_open_prs` to the TRUE open
  counts** (not the triaged slice). If left null the dashboard now falls back to
  the owed-list totals, but setting them here is cheaper/clearer.
- `owed_list` — global: `issues_total` / `prs_total` = **true open totals**
  (~8,929 / ~255). Per repo (`per_repo[*].owed_list`): `backlog_issues` /
  `backlog_prs` = true opens; `issues_total`/`prs_total` = awaiting; plus
  `owed_file` pointing at `data/owed/<slug>.json`.
- `category_counts`, `label_counts`, `aging_buckets`, `situation`, `trends`,
  `checked_repos`, `repo_capabilities`, `config`, `skills`.

## Derived client-side — do NOT need to be emitted

The dashboard computes these from the fields above; the collector can ignore them.

1. **Triage State pill** (one, mutually-exclusive). Source: `next_action` if the
   row is deep-triaged, else `baseline_action` (+ `merge_state`/`review_decision`
   for PRs). Vocabulary:
   - Issues: Needs reply / Needs info / Needs labels / Assign (fix vs evaluate) /
     Evaluate demand / Escalate / Reassess stale / Awaiting author /
     Close as duplicate / Tracked / Untriaged.
   - PRs: CI failing / Needs rebase / Changes requested / Needs review /
     Awaiting author / Ready to merge / No action.
   So: **keep `baseline_action` populated on every owed row** — that is what makes
   the full backlog (not just the triaged slice) show a state + a Run-agent action.

2. **Ranking** (default "Priority"): actionable-first → problem tier → recency
   (`updated_at` desc). Keep `updated_at` accurate; keep `next_action`/
   `baseline_action` set so "actionable" is computable.

3. **PowerToys module skills** (PR yeelam-gordon/PowerToys#86): mapped from each
   issue's `Product-*` label → `powertoys-<module>-knowledge`. Purely client-side
   from `labels`, so **no `skill` field is required** — just keep PowerToys
   `Product-*` labels accurate. Labels with no skill in PR #86 (General, Settings,
   PowerRename, Advanced Paste, Quick Accent, Virtual Desktop, Window Manager,
   File Actions Menu, Cursor Wrap) intentionally get no skill.

## Raising coverage (what "do more than the top slice" means)

- The full backlog is already present in `data/owed/<slug>.json`; every row is
  actionable via its baseline state + Run-agent prompt. The lightweight tier is
  intentional (perf: PowerToys alone is ~7.4k rows).
- To deepen quality, **raise the deep-triage cap** (was ~60/repo). The dashboard
  ranks + paginates, so a larger triaged slice is safe. Prioritize:
  1. `up` (reactions) desc, 2. no-reply age, 3. `is_community`, 4. missing labels.
- Never fabricate premium fields for the lightweight tier — leave them absent and
  let the baseline fields drive the row.
