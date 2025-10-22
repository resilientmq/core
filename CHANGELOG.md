# Changelog

All notable changes for this project. This file is generated from the Git commit history. NOTE: there are no Git tags in the repository, so versions were inferred from commit messages that bump the package version (where present). If you prefer strict release tags, I can add annotated tags and re-generate the changelog.

## [0.3.2] - 2025-10-22
### Changed
- Publisher now reads the routing key from each event's `routingKey` field when publishing to an exchange. The exchange configuration is no longer used to supply a per-message routing key. If an event does not specify `routingKey`, the publisher will publish without a routing key (empty string), allowing the broker and bindings to determine delivery.
- Updated API: `EventMessage` now includes an optional `routingKey?: string` field. (See README and types)

## [0.3.0] - 2025-10-02
### Changed
- Enhanced retry and dead-letter queue handling: refactored retry flow and improved DLQ publishing and routing. (commit f899f7b, 2025-10-02)
- Corrected dead letter routing key handling and updated package versions. (commit c6c9804, 2025-10-02)
- Improved overall queue handling and processing flow. (commit ec9fc1b, 2025-10-02)
- Added richer error details and additional exchange bindings for DLQ handling. (commit ff50cd5, 2025-10-01)
- Updated `consumeQueue` configuration to support multiple exchanges. (commit 3bb99fd, 2025-10-01)

## [0.2.9] - 2025-10-02
### Fixed
- Enhanced retry logic with improved dead-letter handling. (commit 3b47b2d, 2025-10-02)

## [0.2.8] - 2025-10-02
### Fixed
- Refactored retry and dead-letter queue handling as part of a version bump to 0.2.8. (commit 938347e, 2025-10-02)

## Earlier history (2025-05-16 → 2025-06-13)
These entries summarize the initial development and subsequent fixes before the 0.2.8+ series.

### Added
- Initial project scaffolding and library upload. (commits e93dbed, 0ca797d, c737838, 95d1fa1)
- Added configuration options and interfaces (more properties, updated types/interfaces). (commit 51b52b1)
- Added `skipEvent` control for starting events and configuration to ignore unknown events. (commits dbd4670, 8850af7)
- Added support for waiting for messages being processed. (commit 243e3fa)

### Changed
- Switched `.d.ts` artifacts to `.ts` and reorganized types directory. (commits d2e47d9, 951760c, 437df98)
- Updated package.json and workflow files. (commits 1af7f27, e850f3e, ca09444)
- Minor code and typo fixes across the codebase. (commits 5801155, c42c501)

### Fixed
- Multiple fixes to consumer/publisher flow, queue declaration and binding order. (commits 9a5606c, 5fd604c, 02ebd98, 475a971)
- Retry and x-death count handling fixes. (commits cacc253, 2f1ada0, 194de62)
- Stability improvements for consumer attempts and connection handling (made connection methods private and more robust). (commits 0534d85, f43f0e2)
- Type fixes and removal of unnecessary dependencies. (commits fb7b020, e95ed7e)
