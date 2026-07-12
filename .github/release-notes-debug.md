## Diagnostic build

This prerelease includes privacy-safe diagnostic logging for private-repository preview testing.

1. Install the attached unpacked Chrome extension.
2. Open DevTools on the GitHub page and any extension preview page.
3. Reproduce the problem.
4. Filter Console output by `[gh-html-preview:debug]`.
5. Copy those entries when reporting the issue.

Logs include lifecycle events, repository paths, request strategy, HTTP status, resource counts, and errors. GitHub tokens and file contents are never logged.
