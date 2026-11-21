# Examples

## Dry run

From any Git repository with a commit:

```sh
swarm init
swarm run "smoke test" --dry-run
swarm status
swarm viz
```

## A tiny real repository

```sh
cp -R examples/textkit /tmp/textkit
cd /tmp/textkit
git init -b main
git add -A && git commit -m "init"
swarm init
swarm plan "add a slugify helper with tests" > plan.json
# review plan.json, then:
swarm run "add a slugify helper with tests" --plan plan.json
```

`examples/plans/add-slugify.json` is a reviewed plan you can pass to `run --plan`.
