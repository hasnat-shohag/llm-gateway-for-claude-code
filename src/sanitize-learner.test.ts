import assert from 'node:assert'
import { SanitizeLearner } from './sanitize-learner.js'
import { looksLikeSanitizeMismatch } from './utils.js'

// --- SanitizeLearner ---------------------------------------------------------
const l = new SanitizeLearner()

// Unlearned → default guess + not-yet-learned.
assert.equal(l.modeFor('X'), true, 'default guess should be true')
assert.equal(l.isLearned('X'), false)

// Learning false locks it.
l.recordSuccess('X', false)
assert.equal(l.isLearned('X'), true)
assert.equal(l.modeFor('X'), false, 'learned value should be returned')

// Re-learning overwrites (a provider can change behavior).
l.recordSuccess('X', true)
assert.equal(l.modeFor('X'), true)

// Snapshot reflects state; providers are independent.
l.recordSuccess('Y', false)
assert.deepEqual(l.snapshot(), { X: true, Y: false })

// --- looksLikeSanitizeMismatch ----------------------------------------------
// 400/401 are mismatch signatures worth flipping for.
assert.equal(looksLikeSanitizeMismatch(400), true)
assert.equal(looksLikeSanitizeMismatch(401), true)
// Quota/tier/rate/server errors are NOT — flipping sanitize won't fix them.
for (const code of [402, 403, 429, 500, 502, 503, 200]) {
  assert.equal(looksLikeSanitizeMismatch(code), false, `${code} must not be a mismatch`)
}

// --- modes ordering invariant (mirrors modesFor in proxy.ts) ----------------
// Unlearned → [guess, flipped] so exactly one flip is possible.
const fresh = new SanitizeLearner()
const guess = fresh.modeFor('Z')
const modes = fresh.isLearned('Z') ? [guess] : [guess, !guess]
assert.deepEqual(modes, [true, false], 'unlearned provider tries both modes, guess first')

console.log('sanitize-learner self-check: OK')
