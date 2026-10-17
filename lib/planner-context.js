import { RULE_ENTRY_HINT, stripEngineSyntax } from './planner.js'

const list = value => Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，\n]/) : []
const clean = values => [...new Set(values.map(v => String(v ?? '').trim()).filter(Boolean))]

/** Normalize ordinary activation metadata while retaining legacy ST keyword fields. */
export function normalizeEntryActivation(raw = {}) {
  raw = raw && typeof raw === 'object' ? raw : {}
  const backendValues = raw.backends ?? raw.backend ?? raw.imageBackends ?? []
  const backends = clean(list(backendValues))
  const explicit = String(raw.activation ?? raw.activationMode ?? '').toLowerCase()
  const rawKeywords = raw.keywords ?? raw.keys ?? raw.key
  const keywords = clean(list(rawKeywords))
  const constant = raw.constant === true || raw.constant === 1 || raw.constant === 'true'
  const enabled = value => value === true || value === 1 || value === 'true'
  const secondary = clean(list(raw.keysecondary))
  const complexTrigger = Boolean(enabled(raw.use_regex) || enabled(raw.useRegex) || enabled(raw.regex)
    || enabled(raw.caseSensitive) || enabled(raw.wholeWords)
    || secondary.length || (enabled(raw.selective) && (raw.selectiveLogic != null || raw.triggerLogic != null)))
  // ST constant entries remain resident. Other simple keyword entries remain conditional.
  const activation = explicit === 'always' || explicit === 'keywords'
    ? explicit
    : (!complexTrigger && !constant && keywords.length && (raw.keywords != null || raw.keys != null || raw.key != null) ? 'keywords' : 'always')
  return { activation, keywords, backends }
}

function matches(text, keyword) {
  const q = String(keyword).trim()
  if (!q) return false
  // Require boundaries only at Latin/numeric ends. CJK text has no spaces between words.
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const isCjk = ch => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)
  const latinWord = '[\\p{Script=Latin}\\p{N}_]'
  const left = isCjk(q[0]) ? '' : `(?:^|[^${latinWord.slice(1, -1)}])`
  const right = isCjk(q[q.length - 1]) ? '' : `(?:$|[^${latinWord.slice(1, -1)}])`
  return new RegExp(`${left}${escaped}${right}`, 'iu').test(String(text))
}

function entryReason(entry, text) {
  const activation = normalizeEntryActivation(entry)
  if (entry.enabled === false || entry.disable === true) return { included: false, reason: 'disabled' }
  if (activation.activation === 'always') return { included: true, reason: 'always' }
  if (!activation.keywords.length) return { included: false, reason: 'empty-keywords' }
  return activation.keywords.some(key => matches(text, key))
    ? { included: true, reason: 'keyword-match' }
    : { included: false, reason: 'keyword-miss' }
}

function characterTerms(character) {
  const name = String(character.name ?? '').trim()
  const aliases = String(character.match ?? '').split(/[,，]/).map(v => v.trim()).filter(Boolean)
  return clean([name, ...aliases])
}

/** Split resident/dynamic rules and scope character detail to names found in the story. */
export function selectPlannerContext({ entries = [], selected = [], text = '', definitions = {}, backend = '', characterUpdates = false } = {}) {
  const staticBlocks = [], dynamicBlocks = []
  const diagnostics = { includedEntries: [], omittedEntries: [], includedCharacters: [], omittedCharacters: [], characterFallback: false }
  const hasEnabled = entries.some(e => e && 'enabled' in e)
  const selectedList = Array.isArray(selected) && selected.length ? selected : RULE_ENTRY_HINT
  const wanted = new Set(selectedList.map(Number))
  for (const entry of entries) {
    const index = Number(entry?.index ?? -1)
    let reason
    if (entry?.enabled === false || entry?.disable === true) reason = { included: false, reason: 'disabled' }
    else {
      const meta = normalizeEntryActivation(entry)
      if (meta.backends.length && !meta.backends.includes(String(backend))) reason = { included: false, reason: 'backend-mismatch' }
      else if (!hasEnabled && !wanted.has(index)) reason = { included: false, reason: 'not-selected' }
      else reason = entryReason(entry, text)
    }
    if (!String(entry?.content ?? '').trim()) reason = { included: false, reason: 'empty-content' }
    const record = { index, comment: String(entry?.comment ?? ''), reason: reason.reason }
    if (!reason.included) { diagnostics.omittedEntries.push(record); continue }
    diagnostics.includedEntries.push(record)
    const body = stripEngineSyntax(entry?.content ?? '').trim()
    if (!body) continue
    const block = `<!-- ${record.comment} -->\n${body}`
    ;(normalizeEntryActivation(entry).activation === 'keywords' ? dynamicBlocks : staticBlocks).push(block)
  }

  const characters = (definitions?.characters ?? []).filter(c => c && c.enabled !== false)
  const hit = characters.filter(c => characterTerms(c).some(term => matches(text, term)))
  const fallback = characters.length > 0 && hit.length === 0
  const included = fallback ? characters : hit
  diagnostics.characterFallback = fallback
  diagnostics.includedCharacters = included.map(c => ({ name: String(c.name ?? ''), stable_id: String(c.id ?? ''), reason: fallback ? 'fallback-no-name-match' : 'name-match' }))
  diagnostics.omittedCharacters = characters.filter(c => !included.includes(c)).map(c => ({ name: String(c.name ?? ''), stable_id: String(c.id ?? ''), reason: 'not-mentioned' }))
  const fullSet = new Set(included)
  const scoped = { ...definitions, characters: included }
  const rosterIndex = characters.filter(c => !fullSet.has(c)).map(c => `- ${String(c.name ?? '')} [stable_id=${String(c.id ?? '')}]`).join('\n')
  return { staticRules: staticBlocks.join('\n\n'), dynamicRules: dynamicBlocks.join('\n\n'), definitions: scoped, rosterIndex, fullTraits: Boolean(characterUpdates), diagnostics }
}
