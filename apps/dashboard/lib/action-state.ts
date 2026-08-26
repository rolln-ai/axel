/**
 * Shared result envelope for `useActionState`-driven server actions.
 *
 * Every action module used to declare its own `{ error?, notice?, data? }`
 * copy; they only ever differed in the `data` payload. Action modules that
 * carry structured data alias this with their payload type, e.g.
 * `type ActionState = ActionStateBase<{ plaintextToken?: string }>`.
 *
 * Kept dependency-free (no "use server", no server-only) so client
 * components can import the type directly.
 */
export interface ActionState<TData = never> {
  error?: string;
  notice?: string;
  /** Optional structured payload the UI renders alongside the notice. */
  data?: TData;
}
