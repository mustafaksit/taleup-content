/**
 * Level rules from docs/02-CONTENT-SPEC.md (app repo).
 * A text passes when >= MIN_COVERAGE of its words are in the level pool
 * (proper nouns count as in-pool), no sentence exceeds maxSentenceWords,
 * and total word count is within [minWords, maxWords].
 */
export const MIN_COVERAGE = 0.95;

export const LEVELS = ['A1', 'A2', 'B1', 'B2'];

export const LEVEL_RULES = {
  A1: {
    poolFile: 'ngsl-500.txt',
    poolLabel: 'NGSL first 500',
    maxSentenceWords: 8,
    minWords: 250,
    maxWords: 400,
    grammar: 'Present simple and present continuous only.',
  },
  A2: {
    poolFile: 'ngsl-1000.txt',
    poolLabel: 'NGSL first 1000',
    maxSentenceWords: 12,
    minWords: 400,
    maxWords: 600,
    grammar: 'Adds past simple and "going to" future.',
  },
  B1: {
    poolFile: 'ngsl-2000.txt',
    poolLabel: 'NGSL first 2000',
    maxSentenceWords: 16,
    minWords: 600,
    maxWords: 900,
    grammar: 'Adds present perfect and first conditional.',
  },
  B2: {
    poolFile: 'ngsl-2800.txt',
    poolLabel: 'NGSL first 2800',
    maxSentenceWords: 22,
    minWords: 900,
    maxWords: 1400,
    grammar: 'Adds passive voice, second/third conditionals, relative clauses.',
  },
};

export const GENRES = ['horror', 'mystery', 'adventure', 'romance', 'scifi', 'daily', 'classic'];
