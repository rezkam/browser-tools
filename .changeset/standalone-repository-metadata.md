---
"@rezkam/browser-tools": patch
---

Point the package at its own standalone repository. `repository.url` is now `git+https://github.com/rezkam/browser-tools.git` with no monorepo `directory`, and `homepage` and `bugs` resolve there too, so npm's repository, homepage, and issue links no longer send consumers to a path that does not hold this package. The skill install command and documentation links now target the same repository, which is the source of both the skill and the package.
