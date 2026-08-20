# API Patterns

## Conventions

<!-- Document API conventions: URL structure, auth, error format, pagination -->

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/v1/... | ... |
| POST | /api/v1/... | ... |

## Error Format

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description"
  }
}
```
