# Changelog

## 0.4.0

- Keep resource-local WriteSet summaries and shared selector constraints within global budgets; widen individual targets on response overflow.
- Calculate command impact after final commit/drain and expose the shared ImpactUnavailableError for post-commit calculation failure.
- Use adapter-certified equalityFields to exclude known rows outside automatically derived fixed equality filters; unknown or incompatible comparisons stay broad.

## 0.1.1

- Move package source, documentation, and releases to the standalone Server-Driven Impact repository.

## 0.1.0

- Initial public release of the database-neutral impact contracts and calculator.
