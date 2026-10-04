/** Provider-neutral image controls shared by native and proxy transports.
 * @module @hydraharness/harness-llm/generation
 */
import { LlmError } from './index.ts'

/** Convert a requested pixel size into the equivalent native image aspect ratio.
 * @param size - Image tool size; omission or auto leaves the provider default.
 * @returns Reduced width:height ratio, or undefined for the provider default.
 */
export function imageAspectRatio(size: unknown): string | undefined {
  if (size === undefined || size === 'auto') return undefined
  const dimensions = typeof size === 'string' ? /^(\d+)x(\d+)$/.exec(size) : null
  const width = Number(dimensions?.[1])
  const height = Number(dimensions?.[2])
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new LlmError('Image size must be auto or positive WIDTHxHEIGHT dimensions.', 'INVALID_GENERATION')
  }
  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b)
  const divisor = gcd(width, height)
  return `${width / divisor}:${height / divisor}`
}
