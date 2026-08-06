import assert from 'node:assert/strict'
import test from 'node:test'

import { renderRecallHit } from '../hooks/team-prompt-recall-format.mjs'

test('draft hits render as one capped name and source line', () => {
  const rendered = renderRecallHit({
    id: 'draft-1',
    name: 'Draft memory',
    source_file: 'team-memory/drafts/draft-memory.md',
    maturity: 'draft',
    content: 'This content must not appear in draft injection.',
  })

  assert.equal(rendered.layer, 'draft')
  assert.equal(rendered.text, 'Draft memory — team-memory/drafts/draft-memory.md')
  assert.equal(rendered.text.length <= 300, true)
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
