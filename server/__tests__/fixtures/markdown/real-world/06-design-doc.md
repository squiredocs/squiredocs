# Design

Emphasis variants like __bold__ and _italic_ are supported.

---

## Rationale

We chose an in-house parser because:

1. Zero runtime dependencies
2. Registry-driven format knowledge

### Trade-offs

Nested lists work:

- top
  - middle
    - deep
