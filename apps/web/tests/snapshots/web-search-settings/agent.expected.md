{
  "name": "web_search",
  "description": "Search the web for current information. Provide non-empty queries in the required queries array within the configured per-call limit. Returns an optional summary answer and a list of source URLs.",
  "parameters": {
    "type": "object",
    "properties": {
      "queries": {
        "type": "array",
        "description": "Required non-empty search queries; merges their results within the configured per-call limits.",
        "items": {
          "type": "string"
        }
      },
      "country": {
        "type": "string",
        "description": "Optional two-letter country code inferred from the requested search location or market, such as vn or us. Omit when unspecified; do not infer location from language alone."
      },
      "language": {
        "type": "string",
        "description": "Optional search language inferred from the prompt, such as vi, en, or zh-cn. Follow explicit language requests; omit when unclear."
      }
    },
    "required": [
      "queries"
    ]
  }
}

Use the web_search tool to discover current information on the web. The required queries array accepts non-empty search queries within the configured per-call limit; use a one-item array for a single search. Infer country and language from the user request when relevant. Use the requested location or market for country, not the prompt language alone; omit hints without enough context. It returns an optional answer plus a list of source URLs. Follow up with web_fetch when you need the full content of a specific result, and cite the relevant URLs as markdown links.
