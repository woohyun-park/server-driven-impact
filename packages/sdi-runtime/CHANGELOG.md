# Changelog

## 0.4.0

- Derive necessary literal equality filters from Query Plans and remove unused count projection/order/optional-join dependencies.
- Guard synchronous native statement factories and operations without converting results to promises; preserve savepoint and command lifetime.

## 0.1.1

- Move package source, documentation, and releases to the standalone Server-Driven Impact repository.

## 0.1.0

- Initial public release of the Query/Command runtime and adapter contract.
