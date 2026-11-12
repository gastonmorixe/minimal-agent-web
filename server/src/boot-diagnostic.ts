/**
 * Format one host boot diagnostic as a stderr line.
 *
 * A diagnostic with a message prints the message. A diagnostic with an empty
 * message and a `code` prints the code, then the data as compact JSON when the
 * data is present.
 */
export function formatBootDiagnostic(d: {
  readonly kind: string
  readonly message: string
  readonly code?: string
  readonly data?: Readonly<Record<string, unknown>>
}): string {
  const prefix = `minimal-agent web: boot ${d.kind}: `
  if (d.message !== "" || d.code === undefined) return `${prefix}${d.message}`
  return d.data === undefined
    ? `${prefix}${d.code}`
    : `${prefix}${d.code} ${JSON.stringify(d.data)}`
}
