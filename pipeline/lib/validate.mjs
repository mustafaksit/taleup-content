import { LEVEL_RULES, MIN_COVERAGE } from './levels.mjs';
import { analyzeSentence, collectProperNouns, loadPool, tokenizeWords } from './tokenize.mjs';

/** All sentence texts of one story level, in reading order. */
export function levelSentences(levelData) {
  return levelData.paragraphs.flatMap((p) => p.sentences.map((s) => s.text));
}

/**
 * Validates one level of a story against docs/02-CONTENT-SPEC.md rules.
 * Returns { ok, coverage, wordCount, violations, longSentences, lengthIssue }.
 */
export function validateLevel(levelData, level) {
  const rule = LEVEL_RULES[level];
  const pool = loadPool(level);
  const sentences = levelSentences(levelData);
  const properNouns = collectProperNouns(sentences);

  let totalWords = 0;
  let violationCount = 0;
  const violations = new Map(); // word -> occurrences
  const longSentences = [];

  for (const sentence of sentences) {
    const { words, violations: sentenceViolations } = analyzeSentence(sentence, pool, properNouns);
    totalWords += words.length;
    if (words.length > rule.maxSentenceWords) {
      longSentences.push({ sentence, wordCount: words.length, max: rule.maxSentenceWords });
    }
    for (const word of sentenceViolations) {
      violationCount += 1;
      violations.set(word, (violations.get(word) ?? 0) + 1);
    }
  }

  const coverage = totalWords === 0 ? 0 : (totalWords - violationCount) / totalWords;
  let lengthIssue = null;
  if (totalWords < rule.minWords) lengthIssue = `too short: ${totalWords} < ${rule.minWords}`;
  if (totalWords > rule.maxWords) lengthIssue = `too long: ${totalWords} > ${rule.maxWords}`;

  return {
    ok: coverage >= MIN_COVERAGE && longSentences.length === 0 && lengthIssue === null,
    coverage,
    wordCount: totalWords,
    violations: [...violations.entries()].map(([word, count]) => ({ word, count })),
    longSentences,
    lengthIssue,
  };
}

/** Validates every level present in a story JSON. Returns per-level reports. */
export function validateStory(story) {
  const reports = {};
  for (const [level, levelData] of Object.entries(story.levels)) {
    reports[level] = validateLevel(levelData, level);
  }
  return reports;
}

/** Word count of one level (used by build-index). */
export function levelWordCount(levelData) {
  return levelSentences(levelData).reduce((sum, s) => sum + tokenizeWords(s).length, 0);
}

export function formatReport(level, report) {
  const lines = [];
  const pct = (report.coverage * 100).toFixed(1);
  lines.push(
    `  ${level}: ${report.ok ? 'GEÇTİ' : 'KALDI'} | kapsam %${pct} | ${report.wordCount} kelime`,
  );
  if (report.violations.length > 0) {
    lines.push(
      `    havuz dışı: ${report.violations.map((v) => `${v.word}(${v.count})`).join(', ')}`,
    );
  }
  for (const s of report.longSentences) {
    lines.push(`    uzun cümle (${s.wordCount}>${s.max}): "${s.sentence.slice(0, 60)}..."`);
  }
  if (report.lengthIssue) lines.push(`    uzunluk: ${report.lengthIssue}`);
  return lines.join('\n');
}
