import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

/** Streams and launch environment used by the interactive mode menu. */
export interface ModeMenuIO {
  input: Readable
  output: Writable
  error: Writable
  stdinIsTTY: boolean
  stdoutIsTTY: boolean
  ci?: string | undefined
}

/** The profile launch selected by the interactive menu, or its exit status. */
export type ModeMenuResult =
  | { kind: 'profile'; profile: 'web' | 'headless'; args: string[] }
  | { kind: 'exit'; code: number }

const MENU_TEXT = [
  '',
  'Hydra Harness',
  '',
  'Choose a mode:',
  '  1) Web       Start the Web UI',
  '  2) Headless  Run one task in this terminal',
  '  3) Desktop   Source checkout only',
  '',
].join('\n')

const NON_INTERACTIVE_TEXT = [
  'hydra: the bare launcher requires an interactive terminal.',
  'Use one of these explicit commands:',
  '  npx @hydra1902/harness web',
  '  npx @hydra1902/harness --profile headless "<task>"',
  'Desktop is available only from a Hydra source checkout; see the Desktop guide.',
].join('\n') + '\n'

const DESKTOP_TEXT = [
  '',
  'Desktop is currently available from a source checkout only.',
  'Run from the repository root:',
  '  pnpm install',
  '  pnpm run build',
  '  pnpm run desktop',
  'There is no supported npm Desktop artifact or npx Desktop command yet.',
].join('\n') + '\n'

function defaultIO(): ModeMenuIO {
  return {
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
    ci: process.env.CI,
  }
}

function isInteractive(io: ModeMenuIO): boolean {
  const runningInCI = io.ci !== undefined && io.ci.trim().length > 0
  return io.stdinIsTTY && io.stdoutIsTTY && !runningInCI
}

/**
 * Run the line-oriented mode selector used by a bare launcher invocation.
 * @param io - streams and environment used by the selector.
 * @returns the selected profile or the status with which the launcher should exit.
 */
export async function runModeMenu(io: ModeMenuIO = defaultIO()): Promise<ModeMenuResult> {
  if (!isInteractive(io)) {
    io.error.write(NON_INTERACTIVE_TEXT)
    return { kind: 'exit', code: 1 }
  }

  const readline = createInterface({ input: io.input, output: io.output, terminal: false })
  const signal = { interrupted: false }
  readline.once('SIGINT', () => {
    signal.interrupted = true
    readline.close()
  })
  const lines = readline[Symbol.asyncIterator]()
  const readLine = async (prompt: string): Promise<string | null> => {
    io.output.write(prompt)
    const result = await lines.next()
    return result.done ? null : result.value
  }

  try {
    io.output.write(MENU_TEXT)
    while (true) {
      const choice = await readLine('Choice [1-3, q]: ')
      if (choice === null || choice === '') {
        return { kind: 'exit', code: signal.interrupted ? 130 : 0 }
      }
      switch (choice.trim().toLowerCase()) {
        case '1':
          return { kind: 'profile', profile: 'web', args: [] }
        case '2': {
          while (true) {
            const task = await readLine('Task: ')
            if (task === null || task === '') {
              return { kind: 'exit', code: signal.interrupted ? 130 : 0 }
            }
            if (task.trim().length > 0) {
              return { kind: 'profile', profile: 'headless', args: [task.trim()] }
            }
            io.error.write('hydra: a Headless task is required.\n')
          }
        }
        case '3':
          io.output.write(DESKTOP_TEXT)
          return { kind: 'exit', code: 1 }
        case 'q':
          return { kind: 'exit', code: 0 }
        default:
          io.error.write('hydra: choose 1, 2, 3, or q.\n')
      }
    }
  } finally {
    readline.close()
  }
}
