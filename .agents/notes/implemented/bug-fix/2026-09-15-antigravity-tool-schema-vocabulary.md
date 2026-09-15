# Agent Note: Antigravity translates a tool schema literal into an enum

Status: implemented

## Problem

Every Antigravity turn failed with `Antigravity request failed with HTTP 400`, before the model saw anything. The request was refused over one keyword in a declared tool's parameters:

```
Invalid JSON payload received. Unknown name "const" at
'request.tools[0].function_declarations[0].parameters.properties[0].value.one_of[0].properties[0].value'
```

The enforced schema subset spells a literal value with `const`, and the compiler preserves it: the committed wire-schema golden (`examples/acp-agent/.../advanced-toolchain/tool-schemas.expected.json`) carries it inside the `oneOf` branches of `cordis_define`, which the shipped composition mounts. Gemini's `Schema` has no such field, and its validator refuses the whole request over the unknown name — so one tool carrying a literal made every turn fail, on every Antigravity model.

The other spelling the harness dialect uses — a boolean `required` beside a property — never reaches the wire and is not part of this: the compiler folds those markers into the object's name list, and the subset's own validator requires `required` to be an array of strings.

## Decision

`toolDeclarations` rewrites each tool's `parameters` before sending them, replacing `const: v` with `enum: [v]` recursively through nested objects, array `items`, and `oneOf` branches. Everything else in the enforced subset is Gemini's own vocabulary and passes through untouched, including the name list, `oneOf`, and `additionalProperties`.

## Alternatives considered

**Strip `const` without replacing it.** Rejected because the keyword carries a real constraint: a literal-valued field would silently accept any value, trading a loud 400 for a wrong request.

**Rewrite the schema dialect so tools emit Gemini's spelling directly.** Rejected because the dialect is shared: the same schemas describe tool outputs, Code Mode types, subagents, and workflows, and the OpenAI-compatible providers read `const` as standard JSON Schema without complaint — sending it to `api.deepseek.com` alongside a name-list `required` is answered with HTTP 200. The one provider whose protobuf vocabulary lacks the field translates at its own boundary.

**Translate every keyword into a Gemini-specific shape.** Rejected as work without a failure behind it: each keyword the subset allows was checked against the endpoint, and `const` is the only one it refuses.

## Consequences

The translation runs per request over every declared tool, and a keyword the subset gains later needs the same question asked — pass it through, or translate it. `additionalProperties` is accepted and ignored by the endpoint, so a harness schema that closes an object does not close it there.

## Testing

`packages/llm/llm-account-auth/tests/antigravity.spec.ts` builds a request from a shipped tool schema and asserts the parameters Gemini receives. Against the live endpoint the same tool is refused with the `Unknown name "const"` error when sent untranslated and answered with HTTP 200 when sent through the translation.
