// The bundle patch tunes compaction-basic for the 1M-window routes (improvement 6): pressure compaction
// starts near 350k tokens instead of 800k, so a long agent session never grows into the size where the
// provider transport starts failing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The plugin has no YAML dependency; the compaction row carries its policy as one JSON line after a marker.
const text = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const block = text.split('\n- id: compaction-basic\n')[1]
const compaction = block === undefined ? undefined : {
  id: 'compaction-basic',
  name: /^\s{2}name:/m.test(block.split('\n- ')[0]) ? 'present' : undefined,
  config: { modelPolicies: JSON.parse(block.match(/modelPolicies: (\[.*\])/)[1]),
    thresholdRatio: /^\s{4}thresholdRatio:/m.test(block.split('\n- ')[0]) ? 'present' : undefined },
}

test('the patch configures compaction-basic in place, without inserting a second one', () => {
  assert.ok(compaction, 'a config row for the base entry id compaction-basic')
  assert.equal(compaction.name, undefined, 'a config-only row; inserting would duplicate the id (fatal at boot)')
})

test('every 1M-window Claude route compacts at 35 % and keeps 8 % verbatim', () => {
  const policies = compaction.config.modelPolicies
  for (const model of ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5']) {
    const p = policies.find((x) => x.provider === 'claude' && x.model === model)
    assert.ok(p, model)
    assert.equal(p.thresholdRatio, 0.35)
    assert.equal(p.retainRatio, 0.08)
    assert.ok(p.retainRatio < p.thresholdRatio)
  }
  assert.equal(compaction.config.thresholdRatio, undefined, 'smaller-window models keep the shipped defaults')
})
