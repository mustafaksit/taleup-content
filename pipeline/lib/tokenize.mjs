import { readFileSync } from 'node:fs';
import path from 'node:path';

import { WORDLISTS_DIR } from './env.mjs';
import { LEVEL_RULES } from './levels.mjs';

/**
 * Irregular past/participle forms mapped to their NGSL lemma, so that
 * "went" validates against pool entry "go". Covers the verbs that show up
 * in narrative prose; regular inflections are handled by lemmaCandidates.
 */
const IRREGULAR = {
  am: 'be', is: 'be', are: 'be', was: 'be', were: 'be', been: 'be', being: 'be',
  has: 'have', had: 'have', did: 'do', done: 'do', does: 'do',
  went: 'go', gone: 'go', came: 'come', saw: 'see', seen: 'see',
  said: 'say', told: 'tell', got: 'get', gotten: 'get', made: 'make',
  knew: 'know', known: 'know', thought: 'think', took: 'take', taken: 'take',
  found: 'find', gave: 'give', given: 'give', felt: 'feel', kept: 'keep',
  left: 'leave', met: 'meet', ran: 'run', read: 'read', sat: 'sit',
  stood: 'stand', heard: 'hear', held: 'hold', brought: 'bring', built: 'build',
  bought: 'buy', caught: 'catch', chose: 'choose', chosen: 'choose',
  drank: 'drink', drove: 'drive', driven: 'drive', ate: 'eat', eaten: 'eat',
  fell: 'fall', fallen: 'fall', flew: 'fly', flown: 'fly', forgot: 'forget',
  forgotten: 'forget', grew: 'grow', grown: 'grow', hid: 'hide', hidden: 'hide',
  hit: 'hit', hurt: 'hurt', laid: 'lay', lay: 'lie', lain: 'lie', led: 'lead',
  lost: 'lose', meant: 'mean', paid: 'pay', put: 'put', rose: 'rise', risen: 'rise',
  sang: 'sing', sung: 'sing', slept: 'sleep', spoke: 'speak', spoken: 'speak',
  spent: 'spend', swam: 'swim', swum: 'swim', taught: 'teach', threw: 'throw',
  thrown: 'throw', understood: 'understand', woke: 'wake', woken: 'wake',
  wore: 'wear', worn: 'wear', won: 'win', wrote: 'write', written: 'write',
  broke: 'break', broken: 'break', began: 'begin', begun: 'begin',
  becomes: 'become', became: 'become', sent: 'send', shone: 'shine', shut: 'shut',
  sold: 'sell', showed: 'show', shown: 'show', struck: 'strike', stuck: 'stick',
  sought: 'seek', let: 'let', cut: 'cut', cost: 'cost', set: 'set',
  forgave: 'forgive', forgiven: 'forgive', earlier: 'early', earliest: 'early',
  oclock: 'clock', bore: 'bear', born: 'bear', beat: 'beat', bent: 'bend',
  bled: 'bleed', blew: 'blow', blown: 'blow', bred: 'breed', burnt: 'burn',
  dealt: 'deal', dug: 'dig', drawn: 'draw', drew: 'draw', dreamt: 'dream',
  fed: 'feed', fought: 'fight', froze: 'freeze', frozen: 'freeze',
  hung: 'hang', lent: 'lend', lit: 'light', rode: 'ride', ridden: 'ride',
  rang: 'ring', rung: 'ring', sank: 'sink', sunk: 'sink', shook: 'shake',
  shaken: 'shake', shot: 'shoot', slid: 'slide', spread: 'spread',
  sprang: 'spring', stole: 'steal', stolen: 'steal', swept: 'sweep',
  swung: 'swing', tore: 'tear', torn: 'tear', wept: 'weep', wound: 'wind',
  children: 'child', men: 'man', women: 'woman', people: 'person', feet: 'foot',
  teeth: 'tooth', mice: 'mouse', lives: 'life', wives: 'wife', knives: 'knife',
  leaves: 'leaf', shelves: 'shelf', wolves: 'wolf', themselves: 'themselves',
  better: 'good', best: 'good', worse: 'bad', worst: 'bad', further: 'far',
  cannot: 'can', wont: 'will', dont: 'do', didnt: 'do', doesnt: 'do',
  isnt: 'be', arent: 'be', wasnt: 'be', werent: 'be', couldnt: 'could',
  wouldnt: 'would', shouldnt: 'should', hasnt: 'have', havent: 'have',
  hadnt: 'have', mustnt: 'must',
};

/**
 * Closed-class grammar words that never count against the vocabulary pool:
 * pronoun/determiner forms and contraction remnants. These are grammar, not
 * vocabulary — the NGSL lemma list carries "she" but not "her", "a" but not
 * "an"; graded readers treat these forms as always available.
 */
const ALWAYS_ALLOWED = new Set([
  'i', 'me', 'my', 'mine', 'myself',
  'you', 'your', 'yours', 'yourself', 'yourselves',
  'he', 'him', 'his', 'himself',
  'she', 'her', 'hers', 'herself',
  'it', 'its', 'itself',
  'we', 'us', 'our', 'ours', 'ourselves',
  'they', 'them', 'their', 'theirs', 'themselves',
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'who', 'whom', 'whose', 'which', 'what',
  'someone', 'anyone', 'everyone', 'no', 'one', 'nobody', 'nothing',
  'something', 'anything', 'everything', 'somebody', 'anybody', 'everybody',
  'not', "n't", 's', 't', 're', 've', 'll', 'd', 'm',
]);

/** Splits a text into sentences (naive but adequate for controlled prose). */
export function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Word tokens for counting: alphabetic runs, apostrophes kept. */
export function tokenizeWords(sentence) {
  return (sentence.match(/[A-Za-z][A-Za-z'’]*/g) ?? []).map((w) => w.replace(/[’]/g, "'"));
}

/**
 * Collects proper nouns across a whole text: any capitalized token that
 * appears in a non-sentence-initial position is treated as a name, so the
 * same name is also exempt when it starts a sentence ("Anna lives...").
 */
export function collectProperNouns(sentences) {
  const names = new Set();
  for (const sentence of sentences) {
    const words = tokenizeWords(sentence);
    words.forEach((token, i) => {
      if (i > 0 && /^[A-Z]/.test(token)) {
        names.add(token);
        names.add(token.replace(/'s$/, ''));
      }
    });
  }
  return names;
}

/** Candidate lemmas for a lowercase token, most specific first. */
export function lemmaCandidates(word) {
  const w = word.toLowerCase().replace(/'/g, '');
  const candidates = new Set([w]);
  if (IRREGULAR[w]) candidates.add(IRREGULAR[w]);

  // possessive / contraction remnants
  for (const suffix of ['s', 'es', 'ies', 'ed', 'd', 'ied', 'ing', 'er', 'est', 'ier', 'iest', 'ly', 'ily']) {
    const stemLength = w.length - suffix.length;
    if (stemLength >= 2 && w.endsWith(suffix)) {
      const stem = w.slice(0, -suffix.length);
      if (['ies', 'ied', 'ier', 'iest', 'ily'].includes(suffix)) candidates.add(`${stem}y`);
      candidates.add(stem);
      candidates.add(`${stem}e`); // hoping -> hope, closed -> close
      // doubled final consonant: running -> run
      if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
        candidates.add(stem.slice(0, -1));
      }
    }
  }
  // irregular lookup also applies to stems: "children's" -> children -> child
  for (const c of [...candidates]) {
    if (IRREGULAR[c]) candidates.add(IRREGULAR[c]);
  }
  return [...candidates];
}

const poolCache = new Map();

/** Loads the merged word pool for a level (level cut + NGSL supplemental). */
export function loadPool(level) {
  if (poolCache.has(level)) return poolCache.get(level);
  const rule = LEVEL_RULES[level];
  const pool = new Set();
  for (const file of [rule.poolFile, 'ngsl-supplemental.txt']) {
    const raw = readFileSync(path.join(WORDLISTS_DIR, file), 'utf8');
    for (const line of raw.split('\n')) {
      const word = line.trim().toLowerCase();
      if (word) pool.add(word);
    }
  }
  poolCache.set(level, pool);
  return pool;
}

/** True when the token (with inflection handling) is inside the pool. */
export function isInPool(token, pool) {
  const w = token.toLowerCase().replace(/'/g, '');
  if (ALWAYS_ALLOWED.has(w)) return true;
  return lemmaCandidates(token).some((c) => pool.has(c));
}

/**
 * Analyzes one sentence against a level pool.
 * Returns { words, violations } where violations are out-of-pool tokens.
 * Proper nouns are exempt: capitalized non-initial tokens, and initial
 * tokens present in the properNouns set (collected across the text).
 */
export function analyzeSentence(sentence, pool, properNouns = new Set()) {
  const words = tokenizeWords(sentence);
  const violations = [];
  words.forEach((token, i) => {
    if (i > 0 && /^[A-Z]/.test(token)) return;
    const base = token.replace(/'s$/, '');
    if (i === 0 && (properNouns.has(token) || properNouns.has(base))) return;
    if (!isInPool(token, pool)) violations.push(token.toLowerCase());
  });
  return { words, violations };
}
