# Zauth and this repository

**What it is.** [Zauth](https://zauth.inc) sells security tooling for agentic apps. One product, **RepoScan**, scans a public GitHub repository and returns a **trust score from 0 to 100**. According to its documentation the score "combines multiple signals: code originality, repository age, commit history, contributor diversity, and overall development effort", where high similarity to other public repositories lowers the score and unique code with real development history raises it. Bands: 0-30 High Risk, 31-70 Caution, 71-100 Lower Risk. Zauth itself says "a high score doesn't guarantee safety".
Source: <https://zauth.inc/docs/reposcan>.

**What the score cannot be told.** Zauth publishes no checklist of what earns a 100. Four of the five inputs (repo age, commit history, contributor diversity, development effort) are properties of a repository's *history on GitHub*. They cannot be supplied by a zip file, and they should not be faked. A brand-new repository with one author and one commit will not look the way a mature one does, whatever the code quality.

**What this repository does that is within its control**

| Signal | What is true here |
|---|---|
| Code originality | Written for this project. No copied boilerplate or vendored code. Dependencies are consumed from npm, not copied in. |
| Development effort | Substantial, tested implementation (see test counts in the README / CI), a Solana venue with a pre-sign simulation guard, docs, CI, Docker. |
| Commit history | The repository ships with a short, honest git history: the commits describe the real work as it was organised, are dated when they were made, and have one author. Nothing is backdated and there are no invented contributors. Keep committing normally after you push. |
| Contributor diversity / age | Time and other people. `CONTRIBUTING.md` makes it easy to join. |

Nobody can honestly guarantee a score of 100, and this project does not claim one. Run RepoScan on the repo once it is on GitHub and treat its findings as input.
