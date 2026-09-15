# Agent Note: Antigravity translates the tool schema into Gemini's vocabulary

Status: implemented

## Problem

Every Antigravity turn that declared tools failed with
`Antigravity request failed with HTTP 400`. The cause was in the tool
declarations the request carried, not in the model that was selected:

```
Invalid value at
'request.tools[0].function_declarations[0].parameters.properties[0].value.required'
(TYPE_STRING), true
```

Gemini's `Schema` takes `required` as a list of property names on the object,
while the harness dialect marks a property required with a boolean beside it.
A second schema keyword is refused the same way — `Unknown name "const"` — which
the harness uses for a literal value.

Both spellings are in shipped tool schemas: `required: true` appears on 376
properties, and `const` on the bash, pwsh, cordis, lsp, and agent-team tools.
The serializer passed `tool.parameters` through untouched, so the first request
of any session that declared a tool was rejected — before the model saw
anything — on every Antigravity model.

## Decision

`toolDeclarations` rewrites each tool's `parameters` into Gemini's vocabulary
before sending them: a property's boolean `required` moves the property's name
into the enclosing object's `required` list, and `const: v` becomes
`enum: [v]`. Nested objects and array `items` are rewritten the same way. Every
other keyword the harness subset allows is already Gemini's own and passes
through unchanged.

## Alternatives considered

**Keep passing the harness schema through.** Rejected — that is the defect: the
endpoint validates the schema before it runs the request and refuses the whole
call.

**Strip `required` and `const` markers instead of translating them.** Rejected
because both carry real constraints. Dropping the required marker would invite
calls the tool then rejects, and dropping `const` would let a literal-valued
field take any string, trading a loud 400 for a wrong request.

**Emit Gemini's spelling from the tool definitions themselves.** Rejected
because the dialect is shared: the same schemas describe tool outputs, Code Mode
types, subagents, and workflows, and other providers read them as JSON Schema.
The provider that needs another spelling translates at its own boundary.

## Consequences

The translation runs per request over every declared tool, and a keyword the
harness adds to its schema subset later needs a decision here — pass it through,
or translate it — which the tool-schema test states for the two that are
translated today. `additionalProperties`, which the harness uses to mean a
free-form object, is tolerated by the endpoint and passes through as written.

## Testing

`packages/llm/llm-account-auth/tests/antigravity.spec.ts` builds a request from
a harness-shaped schema — a boolean `required` beside two properties, a `const`
literal, and a nested object with its own required property — and asserts the
parameters Gemini receives. Against the live endpoint the same translated schema
is answered with HTTP 200, while the untranslated one is refused with the
`TYPE_STRING` error above.
