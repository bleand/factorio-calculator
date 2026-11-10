PORT ?= 5173

.PHONY: help install run run-local run-frontend run-frontend-debug update-data test

help:
	@echo "make run                 Serve the site at http://localhost:$(PORT) (alias: run-local, run-frontend)"
	@echo "make run-frontend-debug  Serve with the Node inspector enabled"
	@echo "make update-data         Regenerate site/data from the latest stable Factorio release"
	@echo "                         ARGS='--force' or ARGS='--version 2.1.24'"
	@echo "make test                Run the solver tests"
	@echo "make install             Install dev dependencies (only needed for update-data)"

install:
	npm install

run run-local run-frontend:
	node tools/serve.mjs $(PORT)

run-frontend-debug:
	node --inspect tools/serve.mjs $(PORT)

update-data: node_modules
	node tools/update-data.mjs $(ARGS)

test:
	node --test

node_modules:
	npm install
