# Proofread structured output contract

## JSON Schema (Structured Outputs)

```json
{
  "type": "object",
  "properties": {
    "edits": {
      "type": "array",
      "maxItems": 30,
      "items": {
        "type": "object",
        "properties": {
          "op": {
            "type": "string",
            "enum": ["replace", "insert_before", "insert_after", "delete"]
          },
          "target": { "type": "string" },
          "replacement": { "type": "string" },
          "occurrence": { "type": "integer", "minimum": 1 },
          "before": { "type": "string" },
          "after": { "type": "string" },
          "rationale": { "type": "string" }
        },
        "required": ["op", "target"],
        "additionalProperties": false
      }
    },
    "rewrite_text": { "type": "string" }
  },
  "required": ["edits"],
  "additionalProperties": false
}
```

## Example request (single block)

```json
{
  "blockId": "paragraph-12",
  "text": "Он сказал: “я скоро вернусь”.\nНо потом он не пришёл.",
  "language": "ru",
  "goals": ["Исправь пунктуацию и орфографию, сохраняя стиль."]
}
```

## Example response

```json
{
  "edits": [
    {
      "op": "replace",
      "target": "“я скоро вернусь”.",
      "replacement": "«Я скоро вернусь».",
      "occurrence": 1,
      "before": "Он сказал: ",
      "after": "\n"
    },
    {
      "op": "replace",
      "target": "не пришёл",
      "replacement": "не пришел",
      "occurrence": 1,
      "before": "Но потом он ",
      "after": "."
    }
  ]
}
```
