'use strict';

/**
 * validation/testData.js
 *
 * Curated test data for the Nightly Validation Suite.
 *
 * These are well-known, long-running anime titles that should exist on every
 * major provider. They are used for:
 *   - searchQuality (natural + trickier queries)
 *   - stream extraction (episode probing)
 *   - metadata completeness
 *
 * Keep this file data-only so validators stay fully data-driven and new titles
 * can be added without touching logic.
 */

const ANIME_TITLES = [
  {
    title: 'One Piece',
    aliases: ['ワンピース', 'Wan Pīsu', 'OP'],
    searchQueries: ['One Piece', 'ワンピース'],
    episode: 1,
  },
  {
    title: 'Naruto',
    aliases: ['ナルト', 'Narutō'],
    searchQueries: ['Naruto', 'ナルト'],
    episode: 1,
  },
  {
    title: 'Jujutsu Kaisen',
    aliases: ['Jujutsu Kaisen', '呪術廻戦', 'JJK'],
    searchQueries: ['Jujutsu Kaisen', '呪術廻戦', 'Jujutsu Kaisen Season 2'],
    episode: 1,
  },
  {
    title: 'Demon Slayer',
    aliases: ['Kimetsu no Yaiba', '鬼滅の刃', 'Demon Slayer Kimetsu no Yaiba'],
    searchQueries: ['Demon Slayer', 'Kimetsu no Yaiba', '鬼滅の刃'],
    episode: 1,
  },
  {
    title: 'Steins Gate',
    aliases: ['Steins;Gate', 'シュタインズ・ゲート'],
    searchQueries: ['Steins Gate', 'Steins;Gate', 'シュタインズ・ゲート'],
    episode: 1,
  },
  {
    title: 'Attack on Titan',
    aliases: ['Shingeki no Kyojin', '進撃の巨人', 'AOT', 'SnK'],
    searchQueries: ['Attack on Titan', 'Shingeki no Kyojin', '進撃の巨人', 'AOT'],
    episode: 1,
  },
  {
    title: 'Fullmetal Alchemist Brotherhood',
    aliases: ['FMAB', 'ハガネの錬金術師', 'Fullmetal Alchemist: Brotherhood'],
    searchQueries: ['Fullmetal Alchemist Brotherhood', 'FMAB', 'ハガネの錬金術師'],
    episode: 1,
  },
  {
    title: 'My Hero Academia',
    aliases: ['Boku no Hero Academia', '僕のヒーローアカデミア', 'MHA'],
    searchQueries: ['My Hero Academia', 'Boku no Hero Academia', '僕のヒーローアカデミア', 'MHA'],
    episode: 1,
  },
  {
    title: 'Sword Art Online',
    aliases: ['SAO', 'ソードアート・オンライン'],
    searchQueries: ['Sword Art Online', 'SAO', 'ソードアート・オンライン'],
    episode: 1,
  },
  {
    title: 'Re:Zero',
    aliases: ['ReZero', 'Re:Zero - Starting Life in Another World', 'リゼロ'],
    searchQueries: ['Re:Zero', 'ReZero', 'リゼロ'],
    episode: 1,
  },
];

/**
 * Search quality probes designed to stress the search matcher:
 *   - exact title
 *   - romaji
 *   - Japanese
 *   - common abbreviation
 *   - misspelling
 *   - partial / season suffix
 */
const SEARCH_QUERIES = [
  { title: 'One Piece', query: 'One Piece' },
  { title: 'One Piece', query: 'ワンピース' },
  { title: 'Naruto', query: 'Naruto' },
  { title: 'Naruto', query: 'ナルト' },
  { title: 'Jujutsu Kaisen', query: 'Jujutsu Kaisen' },
  { title: 'Jujutsu Kaisen', query: 'Jujutsu' },
  { title: 'Demon Slayer', query: 'Demon Slayer' },
  { title: 'Demon Slayer', query: 'Kimetsu no Yaiba' },
  { title: 'Steins Gate', query: 'Steins;Gate' },
  { title: 'Steins Gate', query: 'Stein Gate' },
  { title: 'Attack on Titan', query: 'AOT' },
  { title: 'Attack on Titan', query: 'Shingeki no Kyojin' },
  { title: 'Fullmetal Alchemist Brotherhood', query: 'FMAB' },
  { title: 'My Hero Academia', query: 'MHA' },
  { title: 'Sword Art Online', query: 'SAO' },
  { title: 'Re:Zero', query: 'Re:Zero' },
  { title: 'Re:Zero', query: 'ReZero' },
];

/**
 * Default number of results to request in search-quality probes.
 */
const SEARCH_RESULT_LIMIT = 10;

/**
 * Provider ids the validator should always attempt (used by readiness to
 * guarantee a baseline even if the registry is temporarily filtered).
 */
const ALWAYS_INCLUDE_PROVIDERS = ['animeheaven', 'consumet-http'];

module.exports = {
  ANIME_TITLES,
  SEARCH_QUERIES,
  SEARCH_RESULT_LIMIT,
  ALWAYS_INCLUDE_PROVIDERS,
};
