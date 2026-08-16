/**
 * The fetch surface used by provider adapters.
 *
 * Defined separately from `typeof fetch` because Bun's fetch adds static
 * members (e.g. `preconnect`) that plain functions cannot satisfy, which
 * makes test doubles awkward.
 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
