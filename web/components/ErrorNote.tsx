import { ApiError, FMP_KEY_NOTE, needsFmpKey } from "../lib/api";

/** A widget's query error: a one-line note for a missing key, the route's own text for other 503s, else a red error. */
export default function ErrorNote({ error }: { error: unknown }) {
  if (needsFmpKey(error)) return <div className="p-2 dim">{FMP_KEY_NOTE}</div>;
  const message = (error as Error).message;
  if (error instanceof ApiError && error.status === 503) return <div className="p-2 dim">{message}</div>;
  return <div className="p-2 down">Error: {message}</div>;
}
