# Releasing

1. Pick a unique npm package name and update `name` in `package.json`; `swarm-mvp` is a working title. Confirm the `repository`, `homepage` and `bugs` URLs point at the real GitHub repository.
2. Confirm `LICENSE`, `SECURITY.md`, `README.md` and `docs/` are current.
3. Run:
   ```sh
   npm ci
   npm run typecheck
   npm test
   npm run pack:check
   ```
4. Inspect `npm pack --dry-run`: `dist/`, `README.md`, `LICENSE`, `SECURITY.md`, `docs/` and `examples/` should be included; `test/`, `.swarm/`, `node_modules/` should not.
5. Test the packed artifact in an empty directory:
   ```sh
   npm pack
   mkdir /tmp/swarm-install && cd /tmp/swarm-install
   npm init -y
   npm i /path/to/swarm-mvp-0.1.0.tgz
   npx swarm --help
   ```
6. Publish with provenance from CI:
   ```sh
   npm publish --provenance
   ```
7. Tag the release and add a `CHANGELOG.md` entry.
8. Build the container image:
   ```sh
   docker build -t swarm-mvp .
   ```
