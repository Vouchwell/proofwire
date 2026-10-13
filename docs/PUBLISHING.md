# Publishing

Two paths. The second is the one to use once it is set up.

---

## The rename from Proofwire

Up to 0.5.0 the project was **Proofwire**: npm packages `proofwire` and
`@proof_wire/*`, the `pw` command, and the GitHub organisation `proofwire`.
It was renamed because another developer tools company was already using the
name. Those releases stay on npm as they are; the next release is the first
under the new names, and the old packages get a deprecation notice pointing
here (see "After the rename" below).

## What is already done

- The repository is public, with GitHub's private vulnerability reporting on,
  so the link in [`SECURITY.md`](../SECURITY.md) works.
- 0.2.0, 0.3.0 and 0.5.0 were published under the old names, from tagged
  commits, each with a GitHub release carrying its `CHANGELOG.md` section.
- The website is live at <https://vouchwell.axonscape.com/>. It is static files in `site/`, deployed by
  `.github/workflows/pages.yml`; the site's own tests gate the deploy and
  `site/test/` is not published.
- CI runs the full suite on Linux, macOS and Windows, on Node 22 LTS and 24,
  plus a compatibility job that exercises the core on Node 20.11 — the oldest
  version it claims to support.
- Every package carries its own README, LICENSE and repository metadata, so
  each npm page links back to its own subtree rather than the repo root.
- Scoped packages are marked `publishConfig.access=public`, which they need
  in order to publish at all under a free org.
- `npm run release:dry` passes except for authentication.

## What is not, and cannot be from here

Publishing needs npm credentials. Nothing in this repository asks for them and
nothing stores them — that is deliberate. Both paths below put the credential
somewhere you control.

---

## Releasing, in short

0.6.0 was the first release as Vouchwell: npm, PyPI and the GitHub release
are out. From here a release is a version bump and a tag:

1. `npm run bump -- 0.6.1`, then commit and merge it.
2. Push the tag: `git tag -a v0.6.1 -m "Vouchwell 0.6.1" && git push origin v0.6.1`.
   The release workflow tests on three operating systems, publishes the five
   npm packages and the Python SDK (both with no token, by trusted
   publishing), and creates the GitHub release. The website's install line
   follows by itself.

This needs the npm trusted publishers ([Path 2](#path-2--from-ci-every-time-after-that))
and the PyPI one ([below](#the-python-sdk-pypi)) to be in place. If a run
stops halfway, [finish it](#finishing-a-release-that-stopped-halfway) rather
than bumping again.

## Path 1 — from your machine

How 0.2.0, 0.3.0 and 0.4.0 were released. First, **bump**: write what the
release changes under `## Unreleased` in `CHANGELOG.md`, then

```bash
npm run bump -- 0.4.1           # every package, every internal pin, the Python
                                # SDK, the lockfile, and the CHANGELOG heading
git commit -am "Release 0.4.1" && git push
```

Then publish and tag:

```bash
npm login                       # opens a browser
npm run release:dry             # the preflight, publishing nothing
npm run release                 # asks for a 2FA code per package
git tag -a v0.4.1 -m "Vouchwell 0.4.1" && git push origin v0.4.1
```

The preflight refuses to publish a version that is already on npm, a
package pinning another at an older version, a version with no CHANGELOG
section, or a Python SDK at a different number. Forgetting to bump used to
look like a successful release that skipped every package.

Tag *after* publishing. The tag push runs `.github/workflows/release.yml`,
which re-runs the suite on three operating systems, sees every package at the
tagged version already on npm and skips publishing, then uploads the Python
SDK and creates the GitHub release from that version's `CHANGELOG.md` section.

### First time only: create the scope

The four `@vouchwell/*` packages need an npm org to live in. It is free for
public packages:

**https://www.npmjs.com/org/create** → name it `vouchwell`.

Without it those four fail to publish, and it is not optional for the CLI
either: the unscoped `vouchwell` package depends on `@vouchwell/core` and
`@vouchwell/proxy`, so a CLI published without them installs nowhere.

### What the script does

Preflight, then publish in dependency order:

```
core  →  proxy  →  dashboard  →  server  →  cli
```

Order matters. Publishing the CLI before the proxy leaves a package on the
registry whose dependency does not exist yet: briefly uninstallable, and not
fixable by unpublishing.

Preflight refuses to continue on a failing test run, a dirty working tree,
mismatched versions, or missing auth. A version already on the registry is
skipped, so a re-run after a partial failure resumes rather than erroring.

> **npm is effectively write-once.** `npm unpublish` works for 72 hours, and
> the name is held forever either way. Run the dry run first.

---

## Path 2 — from CI, every time after that

Better for a security product, for three reasons: the artifact is built from a
tagged commit anyone can inspect, npm records **provenance attestations**
linking each tarball to the workflow run that produced it, and no long-lived
credential sits on a laptop.

### Setup, once: npm trusted publishing

There is no npm token. npm accepts an upload because GitHub vouches that it
comes from `.github/workflows/release.yml` in this repository, so there is
nothing to steal and no two-factor code to type; provenance is attached
automatically. On <https://www.npmjs.com>, for **each** of the five packages
(`vouchwell`, `@vouchwell/core`, `@vouchwell/proxy`, `@vouchwell/dashboard`,
`@vouchwell/server`): **Settings → Trusted Publisher → GitHub Actions**, and
enter exactly:

| Field | Value |
| --- | --- |
| Organization or user | `Vouchwell` |
| Repository | `vouchwell` |
| Workflow filename | `release.yml` |
| Environment | leave empty |

Then, on the same page, set **Publishing access** to *Require two-factor
authentication and disallow tokens*. Trusted publishing keeps working, and no
token, leaked or forgotten, can publish these packages again.

Publishing by hand ([Path 1](#path-1--from-your-machine)) stays possible with
your login and two-factor code, for emergencies.

### Releasing

```bash
npm run bump -- 0.4.1
git commit -am "Release 0.4.1"
git tag -a v0.4.1 -m "Vouchwell 0.4.1"
git push && git push --tags
```

(Not `npm version --workspaces`: it leaves the internal `@vouchwell/*` pins at
the old version, so the new CLI would install the old core.)

The tag triggers `.github/workflows/release.yml`, which re-runs the full suite
on three operating systems, checks the tag matches the manifests, publishes
with provenance, waits until every package is visible on npm, and creates the
GitHub release from that version's `CHANGELOG.md` section.

Try it first with **Actions → Release → Run workflow → dry run: true**.

### Finishing a release that stopped halfway

If npm was published by hand (or an attempt failed after some packages went
out), finish from **Actions → Release → Run workflow** with **tag** set to the
release's tag, say `v0.6.0`, and **dry run** off. It builds from that tag,
skips every package npm already has (`release.js --resume`), then uploads the
Python SDK to PyPI and creates the GitHub release. A tag push does the same, so
re-running a failed tag build also resumes rather than demanding a new version.

---

## After the first publish

```bash
npx vouchwell@latest --version
npm view vouchwell
```

Then the things that are not automatable and are worth doing deliberately:

- [ ] Check the site noticed. The Pages workflow reruns when Release finishes
      and writes the version into `site/release.json`, which reveals the install
      line on the page. It does so only if `npm view vouchwell repository.url`
      points at this repository: the CLI's name is unscoped, so without that
      check anyone who registered it first would be advertised here. Done for 0.2.0.
- [ ] Enable **2FA on the npm account**. A compromised publish account on a
      package that claims to make things tamper-evident is the worst available
      outcome.
- [ ] Turn on **branch protection** for `main`, requiring CI to pass.
- [ ] Add the repository to **GitHub's secret scanning and Dependabot alerts**
      (Settings → Code security).
- [ ] Commission the cryptographic review in
      [`AUDIT-BRIEF.md`](AUDIT-BRIEF.md) — the one remaining blocker for a
      hosted service, and the thing to do before charging anyone.

## The MCP Registry

`server.json` at the repository root is Vouchwell's entry in the official MCP
Registry (registry.modelcontextprotocol.io). The entry runs `npx vouchwell mcp`.
The registry accepts it only when two things are true:
- the npm package of that version carries
  `"mcpName": "io.github.Vouchwell/vouchwell"`. `packages/cli/package.json` has
  it from 0.7.0 on, so publish after that release is on npm, not before;
- whoever publishes can sign in to GitHub as a member of the `Vouchwell`
  organization.

`npm run bump` moves the versions in `server.json` with everything else. After
each release:

```bash
brew install mcp-publisher        # or the binary from the registry's GitHub releases
mcp-publisher login github         # opens the browser; use an account in the Vouchwell org
mcp-publisher publish              # reads ./server.json
```

Directories that mirror the registry (GitHub's MCP listing, PulseMCP and
others) pick the entry up from there.

## The website's address

The site is at <https://vouchwell.axonscape.com/>. It is still built and
deployed by `.github/workflows/pages.yml`, only now under that domain rather than a
`github.io` address. Every path on the site is relative, so the move changed
where it is served from, not the site. `index.html` names the domain as its
canonical address, and `site/test` holds it to that.

Setting the domain up takes two account actions, which CI cannot do:

1. **DNS**, at whoever serves `axonscape.com`: a `CNAME` record named
   `vouchwell` pointing to `vouchwell.github.io`, the organisation's
   `github.io` host. Remove any `A` or `AAAA` record for `vouchwell`, which
   would conflict. Never leave it pointing at `proofwire.github.io`: since
   the rename that host belongs to nobody here, and whoever registers a
   `proofwire` account could serve pages on this domain.
2. **GitHub**, in **this** repository (`Vouchwell/vouchwell`):
   - Settings → Pages → Custom domain → `vouchwell.axonscape.com` → Save.
     With a workflow deploy GitHub ignores a `CNAME` file, so the setting is
     the only place the domain lives.
   - Not in `Vouchwell.github.io`. A domain set there makes the redirect
     page answer at the domain's root, and that page redirects to the
     domain's root: a loop. (It also moves this site to `/vouchwell/`, since
     an organisation site's domain serves its project sites under their
     names.) GitHub lets one repository hold a domain at a time; if this
     one says the domain is taken, remove it from the other first.
   - Once the DNS check passes, tick **Enforce HTTPS**.
   - Then, in the organisation's Settings → Pages, **verify** `axonscape.com`.
     A verified domain cannot be claimed by another GitHub account if this
     site's setting is ever removed, which closes the subdomain-takeover gap.

When the domain is set, GitHub redirects the old project address
(`vouchwell.github.io/vouchwell/`) to it. The bare hostname,
`vouchwell.github.io`, is served by the one-file redirect repository
`Vouchwell.github.io`, which sends it to the same place.

The repository was transferred from a personal account, which left three things
worth knowing:

- GitHub redirects the old repository and `git` URLs. It does not redirect the
  old personal `github.io` address, which now returns 404.
- `repository` in each `package.json` already names this repository, so the
  first publish carries the right value. The site's npm check compares it with
  `GITHUB_REPOSITORY`; a package published under the old owner's URL would,
  correctly, not be advertised.
- Pages, private vulnerability reporting, the homepage and the topics all
  survived the transfer; that was checked, not assumed.

## After the rename

Once, in this order. Each is an account action, so none can be done from CI.

1. **GitHub.** *Done:* the organisation, this repository and the redirect
   repository are now `Vouchwell`, `vouchwell` and `Vouchwell.github.io`.
   Rename the organisation `proofwire` to `vouchwell`
   (Settings → Rename organization), then the repository `proofwire` to
   `vouchwell`, and `proofwire.github.io` to `vouchwell.github.io`. GitHub
   redirects the old repository URLs, so existing clones and links keep
   working. The website stays at <https://vouchwell.axonscape.com/>; update the DNS record's target
   to `vouchwell.github.io`.
2. **npm.** Create the org `vouchwell` (https://www.npmjs.com/org/create), so
   the `@vouchwell/*` packages have somewhere to publish.
3. **Release.** Bump to the next version and publish as in Path 1 or 2. It is
   the first release of `vouchwell` and `@vouchwell/*`.
4. **Point the old packages at the new ones**, so anyone installing them is
   told where the project went. The old versions stay installable:

   ```bash
   npm deprecate proofwire "Renamed to vouchwell: npm i -g vouchwell"
   for p in core proxy dashboard server; do
     npm deprecate "@proof_wire/$p" "Renamed to @vouchwell/$p"
   done
   ```
5. **PyPI.** Publish `vouchwell` (below). The old name was never published
   there, so there is nothing to deprecate.

Existing users need to change nothing to keep working: the CLI still finds a
`.proofwire/` log and `proofwire.*.json` files, `~/.proofwire` credentials and
`PROOFWIRE_*` settings; the hub keeps using a `proofwire.db` and still answers
at `/.well-known/proofwire`; and bundles labelled `proofwire.bundle` verify.

## The Python SDK (PyPI)

The Python package lives in `sdk/python`. It's published as **`vouchwell`**
and imported as `vouchwell`, the same name as on npm.

It is published by the same tag as npm: the `pypi` job in
`.github/workflows/release.yml` runs after the npm packages are out, checks
that the tag, `pyproject.toml` and `__init__.py` agree, builds the sdist and
wheel, and uploads them with **trusted publishing**. PyPI accepts the upload
because GitHub vouches that it comes from that workflow in this repository,
so no PyPI token exists to leak.

**Once, before the first release:** on <https://pypi.org>, with two-factor
authentication on, open **Your account → Publishing → Add a new pending
publisher** and enter exactly:

| Field | Value |
| --- | --- |
| PyPI project name | `vouchwell` |
| Owner | `Vouchwell` |
| Repository name | `vouchwell` |
| Workflow name | `release.yml` |
| Environment name | `pypi` |

A pending publisher reserves nothing. The first successful upload creates the
project, and until then anyone could register the name. So do this shortly
before tagging. In GitHub, **Settings → Environments → `pypi`** (created on the
first run) can additionally require a reviewer to approve each upload.

**By hand, if ever needed** (from the repository root):

```bash
cd sdk/python
python -m pip install --upgrade build twine
python -m build                      # sdist and wheel into dist/
python -m twine check dist/*
python -m twine upload dist/*        # a PyPI API token; username __token__
```

Check it installs cleanly:

```bash
python -m venv /tmp/pwcheck && /tmp/pwcheck/bin/pip install vouchwell
/tmp/pwcheck/bin/python -c "import vouchwell; print(vouchwell.__version__)"
```

## Versioning

All five packages release at the same version; preflight enforces it. The wire
format is versioned separately (`"v": 1` in every receipt) and will be
migrated rather than broken.
