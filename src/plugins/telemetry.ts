/**
 * Plugin → runner telemetry channel.
 *
 * DSH plugins run inside the headless child process whose stdout carries the
 * NDJSON event stream. Hearth plugins therefore report on stderr, one line per
 * event, prefixed with a marker the runner recognizes. Lines never contain
 * secrets: callers pass only identifiers, counts, and short reasons.
 */
export const TELEMETRY_PREFIX = '@@hearth '

export interface TelemetryEvent {
  event: string
  [key: string]: unknown
}

/**
 * Write one telemetry event to stderr.
 * @param event - event name and JSON-safe fields.
 */
export function emitTelemetry(event: TelemetryEvent): void {
  try {
    process.stderr.write(`${TELEMETRY_PREFIX}${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`)
  } catch (error) {
    // stderr closed during shutdown: nothing else can carry the event.
    void error
  }
}

/**
 * Parse a stderr line produced by {@link emitTelemetry}.
 * @param line - one stderr line.
 * @returns the event, or undefined for ordinary diagnostics.
 */
export function parseTelemetryLine(line: string): TelemetryEvent | undefined {
  if (!line.startsWith(TELEMETRY_PREFIX)) return undefined
  try {
    const value = JSON.parse(line.slice(TELEMETRY_PREFIX.length)) as unknown
    if (typeof value === 'object' && value !== null && typeof (value as TelemetryEvent).event === 'string') return value as TelemetryEvent
  } catch (error) {
    void error // malformed marker line: treat as plain diagnostics
  }
  return undefined
}
