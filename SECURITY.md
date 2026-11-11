# Security

Please report a vulnerability in the SDK, the CLI or the app template privately, not in a public issue:
use GitHub's "Report a vulnerability" button on the Security tab of this repository.

Contract issues belong to the contracts repository: https://github.com/gully-labs/gully-core/security.

The CLI never reads a raw private key: it signs only with an encrypted keystore or a hardware wallet, and
simulates every transaction before it asks to sign. A report that it can be made to do otherwise is in scope.
