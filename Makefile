.PHONY: rust-check rust-test rust-clippy ui-install ui-lint ui-test ui-build quality

rust-check:
	cargo check --workspace

rust-test:
	cargo test --workspace

rust-clippy:
	cargo clippy --workspace --all-targets -- -D warnings

ui-install:
	cd apps/desktop && npm install

ui-lint:
	cd apps/desktop && npm run lint

ui-test:
	cd apps/desktop && npm run test

ui-build:
	cd apps/desktop && npm run build

quality:
	./scripts/quality/smoke.sh
	./scripts/quality/chaos.sh
	./scripts/quality/perf.sh
	./scripts/quality/frontend.sh
