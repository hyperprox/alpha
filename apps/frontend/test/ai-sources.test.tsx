// Under an assistant answer: the areas it was read from, behind a closed "Sources used" disclosure, instead of an
// "Attached: ..." line at the top of the answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { sourcesUsed } from '../lib/ai-sources'
import { SourcesUsed } from '../components/ai/SourcesUsed'

test('sources: each name once, in order; nothing to show is null', () => {
  assert.deepEqual(sourcesUsed(['Cluster', 'Backups', 'Cluster', ' ', 7]), ['Cluster', 'Backups'])
  assert.equal(sourcesUsed([]), null)
  assert.equal(sourcesUsed(undefined), null)
})

test('sources: a closed disclosure with the count, the names inside', () => {
  const html = renderToStaticMarkup(<SourcesUsed sources={['Cluster', 'Backups']} />)
  assert.match(html, /^<details[^>]*>/); assert.doesNotMatch(html, /<details[^>]* open/)
  assert.match(html, /<summary[^>]*>Sources used \(2\)<\/summary>/)
  assert.match(html, /Cluster, Backups/)
})
