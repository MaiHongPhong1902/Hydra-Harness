/** Require an explicit shared style or editor/composite role on native UI controls. */
import { globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import ts from 'typescript'

const nonTextInputs = new Set(['checkbox', 'radio', 'file', 'hidden', 'range', 'color', 'button', 'submit', 'reset', 'image'])
const styles = new Set(['field', 'compact'])

/**
 * Find fields and dropdown triggers without a supported styling role.
 * @param source - TSX source to check.
 * @param file - Source path used in diagnostics.
 * @returns One diagnostic per unclassified or incorrectly classified control.
 */
export function findUiControlViolations(source: string, file: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const violations: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(tree)
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute)
      const value = (name: string): string | undefined => {
        const init = attrs.find(attr => attr.name.getText(tree) === name)?.initializer
        const literal = init && ts.isJsxExpression(init) ? init.expression : init
        return literal && ts.isStringLiteral(literal) ? literal.text : undefined
      }
      const popup = value('aria-haspopup')
      const field = tag === 'select' || tag === 'textarea' || tag === 'input' && !nonTextInputs.has(value('type') ?? 'text')
      const picker = tag === 'button' && (popup === 'menu' || popup === 'listbox' || popup === 'tree' || popup === 'true')
      if (field || picker) {
        const style = value('data-hydra-control') ?? ''
        const valid = styles.has(style)
          || style === 'embedded' && tag === 'input'
          || style === 'editor' && tag === 'textarea'
          || style === 'action' && picker
        if (!valid) {
          const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
          violations.push(`${file}:${line}: <${tag}> requires data-hydra-control (see docs/web-styling.md).`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return violations
}

function main(): void {
  const root = resolve(import.meta.dirname, '..')
  const files = globSync(['packages/*/*/src/**/*.tsx', 'apps/*/src/**/*.tsx'], { cwd: root })
    .map(file => file.split(sep).join('/')).sort()
  const violations = files.flatMap(file => findUiControlViolations(readFileSync(resolve(root, file), 'utf8'), file))
  if (violations.length > 0) {
    console.error(violations.join('\n'))
    process.exitCode = 1
  } else {
    console.log(`verify-ui-controls: checked ${files.length} UI sources.`)
  }
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main()
