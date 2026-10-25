"""Python role-1 HTTP boundary. Same JSON Schema as the Node gateway."""
import logging
import asyncio
import hmac
import os
import re
import threading
from contextlib import asynccontextmanager
from uuid import uuid4
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.responses import FileResponse
from jsonschema import ValidationError
from company_context import ContextStore
from .contracts import ROOT, validate, envelope
from .ml import prepare_context, RankAdapter

log = logging.getLogger("integration")


class ApiError(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message


def create_app():
    @asynccontextmanager
    async def lifespan(app):
        mode = os.environ.get("AUTH_MODE", "oidc")
        if mode not in {"oidc", "development"}:
            raise ValueError("AUTH_MODE must be oidc or development")
        if mode != "development":
            if not re.fullmatch(r"[A-Za-z0-9_-]{32,}", os.environ.get("INTERNAL_API_TOKEN", "")):
                raise ValueError("A random INTERNAL_API_TOKEN is required")
            if os.environ.get("CONTEXT_MODE") != "existing" or os.environ.get("RANK_MODE") != "news-analysis":
                raise ValueError("Production ML requires existing company data and news-analysis, without fixtures or mock ranker")
        app.state.database, app.state.context_mode = prepare_context()
        app.state.ranker = RankAdapter()
        app.state.learning = None
        stop = threading.Event()
        worker = None
        if os.environ.get("LEARNING_ENABLED") == "1":
            if (app.state.ranker.mode != "news-analysis" or app.state.context_mode != "existing"
                    or os.environ.get("RANK_MODEL_PATH")):
                raise ValueError("Learning requires news-analysis, existing context and no RANK_MODEL_PATH")
            if len(os.environ.get("LEARNING_TOKEN", "")) < 32:
                raise ValueError("LEARNING_TOKEN must contain at least 32 characters")
            interval = int(os.environ.get("LEARNING_INTERVAL_SECONDS", "60"))
            if interval < 10:
                raise ValueError("Learning interval must be at least 10 seconds")
            from .learning import Learning
            app.state.learning = Learning(os.environ.get("LEARNING_DB", ROOT / "var/learning/registry.sqlite3"))
            app.state.ranker.learning = app.state.learning
            def work():
                while not stop.is_set():
                    try:
                        app.state.learning.run()
                    except Exception:
                        log.exception("Learning cycle failed; active model retained")
                    stop.wait(interval)
            worker = threading.Thread(target=work, name="ranker-learning", daemon=True)
            worker.start()
        try:
            yield
        finally:
            stop.set()
            if worker:
                await asyncio.to_thread(worker.join)

    app = FastAPI(title="Role 1 integration adapter", lifespan=lifespan, docs_url=None, openapi_url=None)

    @app.middleware("http")
    async def boundary(request: Request, call_next):
        candidate = request.headers.get("X-Request-ID", "")
        request.state.request_id = candidate if re.fullmatch(r"[A-Za-z0-9_:.\-]{1,160}", candidate) else str(uuid4())
        if request.url.path != "/v1/health" and os.environ.get("AUTH_MODE") != "development":
            expected = os.environ.get("INTERNAL_API_TOKEN", "")
            supplied = request.headers.get("X-Internal-Token", "")
            if len(expected) < 32 or not hmac.compare_digest(supplied.encode(), expected.encode()):
                return failure(request, 401, "UNAUTHORIZED", "Service authentication required")
        # Bound the stream, including requests without Content-Length.
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 1_000_000:
                return failure(request, 413, "PAYLOAD_TOO_LARGE", "Request exceeds 1 MB")
        request._body = bytes(body)
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        return response

    def failure(request, status, code, message):
        return JSONResponse(status_code=status, headers={"X-Request-ID": request.state.request_id}, content={"schema_version": "1.0.0", "request_id": request.state.request_id,
                            "error": {"code": code, "message": message, "retryable": status in {429, 503, 504}}})

    @app.exception_handler(ApiError)
    async def api_error(request, error):
        return failure(request, error.status, error.code, error.message)

    @app.exception_handler(KeyError)
    async def missing(request, _error):
        return failure(request, 404, "NOT_FOUND", "Company not found")

    @app.exception_handler(ValueError)
    async def invalid(request, _error):
        return failure(request, 422, "VALIDATION_ERROR", "Invalid input")

    @app.exception_handler(Exception)
    async def unexpected(request, _error):
        log.exception("request_failed request_id=%s", request.state.request_id)
        return failure(request, 500, "INTERNAL_ERROR", "Internal error")

    @app.exception_handler(404)
    @app.exception_handler(405)
    async def not_found(request, _error):
        return failure(request, 404, "NOT_FOUND", "Route not found")

    async def read(request, name):
        if request.headers.get("content-type", "").split(";")[0] != "application/json":
            raise ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Expected application/json")
        try:
            value = await request.json()
        except ValueError:
            raise ApiError(400, "VALIDATION_ERROR", "Invalid JSON")
        try:
            return validate(name, value)
        except ValidationError:
            raise ApiError(422, "VALIDATION_ERROR", "Request violates " + name)

    def result(request, name, data, mock=None):
        is_mock = app.state.context_mode == "fixture" if mock is None else mock
        response = envelope(data, request.state.request_id, "mock" if is_mock else "live",
                            ["synthetic_integration_data"] if is_mock else [])
        try:
            return validate(name, response)
        except ValidationError:
            raise ApiError(502, "CONTRACT_VIOLATION", "Provider output violates " + name)

    @app.get("/v1/health")
    def health(request: Request):
        return result(request, "HealthDataResponse", {"status": "ok", "service": "ml"})

    def learning(request):
        if app.state.learning is None:
            raise ApiError(404, "NOT_FOUND", "Learning is disabled")
        supplied = request.headers.get("X-Learning-Token", "")
        if not hmac.compare_digest(supplied.encode(), os.environ["LEARNING_TOKEN"].encode()):
            raise ApiError(403, "FORBIDDEN", "Reviewer token required")
        return app.state.learning

    @app.get("/v1/learning/status")
    def learning_status(request: Request):
        return result(request, "LearningStatusDataResponse", learning(request).status(), False)

    @app.post("/v1/learning/feedback")
    async def feedback(request: Request):
        controller = learning(request)
        body = await read(request, "FeedbackRequest")
        from starlette.concurrency import run_in_threadpool
        try:
            data = await run_in_threadpool(controller.feedback, body, os.environ.get("LEARNING_REVIEWER", "local-reviewer"))
        except ValueError as error:
            raise ApiError(422, "VALIDATION_ERROR", str(error))
        return result(request, "FeedbackDataResponse", data, False)

    @app.get("/learning")
    def learning_page():
        return FileResponse(ROOT / "integration/learning_ui/index.html")

    @app.get("/v1/companies")
    def companies(request: Request):
        try:
            offset = int(request.query_params.get("offset", "0"))
            limit = int(request.query_params.get("limit", "20"))
            if offset < 0 or not 1 <= limit <= 100:
                raise ValueError()
        except ValueError:
            raise ApiError(422, "VALIDATION_ERROR", "Invalid pagination")
        with ContextStore(app.state.database) as store:
            data = {"items": store.list_companies(limit, offset), "offset": offset, "limit": limit}
        return result(request, "CompaniesDataResponse", data)

    @app.get("/v1/companies/{company_id}")
    def profile(company_id: str, request: Request):
        if not re.fullmatch(r"[A-Za-z0-9_:.\-]{1,160}", company_id):
            raise ApiError(422, "VALIDATION_ERROR", "Invalid company ID")
        with ContextStore(app.state.database) as store:
            data = store.get_company_profile(company_id)
        return result(request, "ProfileResponse", data)

    @app.post("/v1/rank")
    async def rank(request: Request):
        body = await read(request, "RankRequest")
        # ContextStore connections belong to this request, never shared across worker threads.
        from starlette.concurrency import run_in_threadpool
        def compute():
            with ContextStore(app.state.database) as store:
                return app.state.ranker.rank(store, body, request.state.request_id)
        data = await run_in_threadpool(compute)
        return result(request, "RankDataResponse", data,
                      app.state.context_mode == "fixture" or app.state.ranker.mode == "mock")

    return app


app = create_app()
