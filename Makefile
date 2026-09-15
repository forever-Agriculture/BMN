.PHONY: test lint typecheck build

test:
	pnpm run test:run

lint:
	pnpm run lint

typecheck:
	pnpm run typecheck

build:
	pnpm run build
