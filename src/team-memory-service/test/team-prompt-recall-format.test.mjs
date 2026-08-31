import assert from 'node:assert/strict'
import test from 'node:test'

import { renderRecallHit } from '../hooks/team-prompt-recall-format.mjs'

// 2026-08-19 L1-⑤（decision kos-upgrade-2026-08-19-trust-axis）：draft 注入从「只给文件名」
// 改为「短摘要 + ⚠️ 标注 + 排序压住」——可信度决定粒度与排序，不决定存在与否。
test('draft hits render as a marked gist plus a source pointer', () => {
  const rendered = renderRecallHit({
    id: 'draft-1',
    name: 'Draft memory',
    source_file: 'team-memory/drafts/draft-memory.md',
    maturity: 'draft',
    content: 'Draft body injected as a gist.',
  })

  assert.equal(rendered.layer, 'draft')
  assert.equal(
    rendered.text,
    '[⚠️draft·未实证] Draft memory\n  Draft body injected as a gist.\n  ↳ team-memory/drafts/draft-memory.md'
  )
  assert.equal(Array.from(rendered.text).length <= 260, true)
})

test('draft gist is capped and keeps the source pointer', () => {
  const rendered = renderRecallHit({
    id: 'draft-3',
    name: 'Long draft',
    source_file: 'team-memory/drafts/long-draft.md',
    maturity: 'draft',
    content: 'x'.repeat(500),
  })

  assert.equal(rendered.layer, 'draft')
  assert.equal(rendered.text.includes('↳ team-memory/drafts/long-draft.md'), true)
  assert.equal(Array.from(rendered.text).length <= 260, true)
})

test('draft rendering failure falls back to the previous full hit format', () => {
  const rendered = renderRecallHit({
    id: 'draft-2',
    name: { toString() { throw new Error('name unavailable') } },
    source_file: 'team-memory/drafts/draft-memory.md',
    maturity: 'draft',
    type: 'rule',
    importance: 1,
    content: 'Fallback body',
  })

  assert.equal(rendered.layer, 'draft')
  assert.match(rendered.text, /^\[id:draft-2 rule draft ★1\]/)
  assert.match(rendered.text, /Fallback body/)
})
