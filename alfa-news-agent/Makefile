.PHONY: setup contracts check dev smoke source compose
PYTHON ?= python
setup:
	$(PYTHON) -m pip install -r requirements-dev.txt -c requirements.lock
	npm ci
contracts:
	$(PYTHON) scripts/build_contracts.py
check:
	$(PYTHON) scripts/build_contracts.py --check
	npm run typecheck
	npm test
	npm run build
	$(PYTHON) -m unittest discover -s tests -p 'test_company_context.py' -q
	$(PYTHON) -m pytest tests/integration -q
dev:
	npm run build
	$(PYTHON) scripts/dev.py
smoke:
	npm run build
	$(PYTHON) scripts/dev.py --smoke
source:
	$(PYTHON) scripts/prepare_news_source.py
compose:
	docker compose up --build --wait
