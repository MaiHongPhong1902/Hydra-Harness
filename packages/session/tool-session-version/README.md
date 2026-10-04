# Session version tools

Registers `session_version_list` and `session_version_read` for the calling agent session. Reads preserve event sequence citations and never switch the active version. Tool results enter context through the normal durable `tool/result` event. No session or agent is created.

`maxReferenceBytes` bounds each UTF-8 reference page including metadata (default 65536, minimum 256). `catalogPageSize` bounds version IDs per list page (default 50). Follow the returned continuation offset to read more. Image blocks remain stored attachment descriptors.

## Model Experience

### Stored version reads

#### What the model sees

The tools return version IDs or a bounded page of stored messages with original event sequence citations. A continuation offset requests the next page without selecting that version.

#### Token effect

Only the requested catalog or reference page enters context through the logged tool result. Other versions remain excluded until read. `catalogPageSize` and `maxReferenceBytes` bound each response.

#### KV Cache effect

Reading appends a tool result to the active transcript. Earlier request messages and shared stored prefix events retain their values.

## Known Limitations and Deferred Work

- Text reads retain image attachment descriptors without decoding image pixels. Reads do not replay tools or restore external file state. Continuation offsets apply to the stored version content; a version extended between pages may contain additional messages.
