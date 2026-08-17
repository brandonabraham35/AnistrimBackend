// utils/contentVisibility.js — Phase 5 shared SQL predicates for publication
// and availability enforcement. Every public path (homepage, trending, popular,
// search, anime details, episode lists, watch page, recommendations, related,
// continue watching, home shelves, catalogue) MUST use these filters.
//
//   anime:    a.is_published = 1
//   episode:  e.is_published = 1
//             AND (e.availability_starts_at IS NULL OR e.availability_starts_at <= NOW())
//             AND (e.availability_ends_at   IS NULL OR e.availability_ends_at   > NOW())
//
// Admin controllers pass includeUnpublished: true (only reachable behind
// protect + adminOnly). Public controllers must NOT accept it from query params.

const PUBLIC_ANIME_FILTER = 'a.is_published = 1';

const PUBLIC_EPISODE_FILTER =
  'e.is_published = 1' +
  ' AND (e.availability_starts_at IS NULL OR e.availability_starts_at <= NOW())' +
  ' AND (e.availability_ends_at IS NULL OR e.availability_ends_at > NOW())';

// For queries that alias episodes as `ep` instead of `e`.
const PUBLIC_EPISODE_FILTER_EP =
  'ep.is_published = 1' +
  ' AND (ep.availability_starts_at IS NULL OR ep.availability_starts_at <= NOW())' +
  ' AND (ep.availability_ends_at IS NULL OR ep.availability_ends_at > NOW())';

module.exports = {
  PUBLIC_ANIME_FILTER,
  PUBLIC_EPISODE_FILTER,
  PUBLIC_EPISODE_FILTER_EP,
};