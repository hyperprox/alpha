// The model the AI page shows, and sends, for Ollama.
//
// A <select> whose value is not one of its options displays its first option while its state still
// holds the old value. The page therefore resolves the value itself: what it shows is what it sends.

/** The stored model when it is installed; otherwise the first installed model; otherwise the stored one. */
export function pickOllamaModel(wanted: string, installed: string[]): string {
  if (!installed.length) return wanted
  const want = wanted.includes(':') ? wanted : `${wanted}:latest`
  return installed.includes(wanted) || installed.includes(want) ? wanted : installed[0]
}
