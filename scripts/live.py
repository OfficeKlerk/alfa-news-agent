"""Run real news collection and company ranking locally, with optional paid LLM calls."""
import argparse
from datetime import datetime, timezone
from contextlib import contextmanager
import errno
import fcntl
import json
import os
import re
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
from urllib.parse import urlsplit
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--context-db", required=True, type=Path,
                        help="Existing company-context SQLite database, opened read-only")
    result.add_argument("--env-file", type=Path, help="Configuration file; defaults to project .env if present")
    result.add_argument("--state-dir", type=Path, default=ROOT / "var/integration/live-news")
    result.add_argument("--data-dir", type=Path, default=ROOT / "data", help="Directory containing bank research data")
    result.add_argument("--with-llm", action="store_true", help="Enable paid model calls using LLM_API_KEY")
    result.add_argument("--check", action="store_true", help="Check configuration only; no HTTP requests or services")
    return result


def read_environment(path, inherited, root=ROOT):
    """Use the same dotenv grammar as the Node services; shell values take precedence."""
    selected = path if path is not None else root / ".env"
    if not selected.is_file():
        if path is not None:
            raise ValueError("--env-file must point to an existing file")
        return dict(inherited)
    code = "const fs=require('node:fs'),u=require('node:util');process.stdout.write(JSON.stringify(u.parseEnv(fs.readFileSync(process.argv[1],'utf8'))));"
    try:
        loaded = subprocess.run(["node", "-e", code, str(selected.resolve())],
                                capture_output=True, text=True, check=True, timeout=10)
        values = json.loads(loaded.stdout)
    except (OSError, ValueError, subprocess.SubprocessError):
        # dotenv contents, including credentials, must never enter a traceback or log.
        raise ValueError("Cannot parse --env-file; Node.js 24 and a valid dotenv file are required") from None
    return {**values, **inherited}


def integer(env, name, default, minimum=1, maximum=65535):
    try:
        value = int(env.get(name, str(default)))
    except (ValueError, TypeError):
        raise ValueError(name + " must be an integer") from None
    if not minimum <= value <= maximum:
        raise ValueError(name + f" must be between {minimum} and {maximum}")
    return value


def runtime_plan(args, inherited, root=ROOT):
    env = read_environment(args.env_file, inherited, root)
    database = args.context_db.resolve()
    if not database.is_file():
        raise ValueError("--context-db must point to an existing company-context SQLite database")
    data = args.data_dir.resolve()
    if not data.is_dir():
        raise ValueError("--data-dir must point to an existing directory")
    if "NEWS_FEEDS_JSON" not in env:
        source_file = root / "config/news-sources.json"
        if source_file.is_file():
            env["NEWS_FEEDS_JSON"] = source_file.read_text(encoding="utf-8")
    try:
        feeds = json.loads(env.get("NEWS_FEEDS_JSON", "[]"))
        valid = isinstance(feeds, list) and bool(feeds) and all(
            isinstance(url, str) and urlsplit(url).scheme == "https" and urlsplit(url).hostname
            and not urlsplit(url).username and not urlsplit(url).password for url in feeds)
    except (ValueError, TypeError):
        valid = False
    if not valid:
        raise ValueError("NEWS_FEEDS_JSON must contain at least one HTTPS RSS/API URL without embedded credentials")
    if len(feeds) > 64:
        raise ValueError("NEWS_FEEDS_JSON supports at most 64 sources")
    if len(set(feeds)) != len(feeds):
        raise ValueError("NEWS_FEEDS_JSON must not contain duplicate source URLs")
    poll = integer(env, "NEWS_POLL_SECONDS", 300, minimum=30, maximum=86400)
    ports = {name: integer(env, variable, default) for name, variable, default in [
        ("gateway", "PORT", 8000), ("ml", "ML_PORT", 8101),
        ("retrieval", "RETRIEVAL_PORT", 8102), ("agent", "AGENT_PORT", 8202)]}
    if len(set(ports.values())) != len(ports):
        raise ValueError("PORT, ML_PORT, RETRIEVAL_PORT and AGENT_PORT must be different")
    if args.with_llm:
        if not env.get("LLM_API_KEY", "").strip():
            raise ValueError("--with-llm requires LLM_API_KEY in --env-file or the environment")
        target = urlsplit(env.get("LLM_BASE_URL", "https://changellenge.up.railway.app/v1"))
        if (target.scheme != "https" or not target.hostname or target.username or target.password
                or target.query or target.fragment):
            raise ValueError("LLM_BASE_URL must be an HTTPS URL without credentials, query or fragment")
        integer(env, "MAX_DAILY_LLM_CALLS", 100, minimum=1, maximum=100000)
    defaults = {
        "NEWS_SOURCE_CONCURRENCY": (3, 1, 8), "NEWS_FULL_TEXT_CONCURRENCY": (3, 1, 8),
        "NEWS_FULL_TEXT_REFRESH_SECONDS": (3600, 60, 604800), "NEWS_FULL_TEXT_MAX_PER_SOURCE": (20, 1, 100),
        "LIVE_SCAN_SECONDS": (60, 10, 86400), "LIVE_LOOKBACK_DAYS": (7, 1, 90),
        "LIVE_MAX_CANDIDATES": (500, 1, 1000), "LIVE_COMPANY_NEWS_LIMIT": (5, 1, 50),
        "LIVE_MAX_COMPANIES": (100, 1, 1000), "LIVE_WORKER_CONCURRENCY": (2, 1, 8),
        "MAX_DAILY_LLM_CALLS": (100, 0, 100000), "MAX_DAILY_LLM_TOKENS": (2_000_000, 0, 1_000_000_000),
        "MAX_COMPANY_DAILY_LLM_CALLS": (20, 0, 100000),
    }
    for name, (default, minimum, maximum) in defaults.items():
        env[name] = str(integer(env, name, default, minimum, maximum))
    for name, default, maximum in [
        ("LLM_QUESTION_RESERVE_CALLS", min(10, int(env["MAX_DAILY_LLM_CALLS"]) // 5), 100000),
        ("LLM_QUESTION_RESERVE_TOKENS", min(200000, int(env["MAX_DAILY_LLM_TOKENS"]) // 5), 1_000_000_000),
    ]:
        env[name] = str(integer(env, name, default, 0, maximum))
    if "LIVE_COMPANY_IDS_JSON" in env:
        try:
            companies = json.loads(env["LIVE_COMPANY_IDS_JSON"])
            valid = (isinstance(companies, list) and len(companies) <= int(env["LIVE_MAX_COMPANIES"])
                     and all(isinstance(item, str) and re.fullmatch(r"[A-Za-z0-9_:.-]{1,160}", item) for item in companies)
                     and len(set(companies)) == len(companies))
        except (ValueError, TypeError):
            valid = False
        if not valid:
            raise ValueError("LIVE_COMPANY_IDS_JSON must contain distinct company IDs within LIVE_MAX_COMPANIES")
    supervisor = {
        "restart_base": integer(env, "LIVE_RESTART_BASE_SECONDS", 1, 1, 60),
        "restart_max": integer(env, "LIVE_RESTART_MAX_SECONDS", 60, 1, 3600),
        "stable_seconds": integer(env, "LIVE_RESTART_STABLE_SECONDS", 60, 1, 3600),
        "startup_timeout": integer(env, "LIVE_STARTUP_TIMEOUT_SECONDS", 60, 5, 600),
        "shutdown_grace": integer(env, "LIVE_SHUTDOWN_GRACE_SECONDS", 30, 1, 300),
    }
    if supervisor["restart_base"] > supervisor["restart_max"]:
        raise ValueError("LIVE_RESTART_BASE_SECONDS must not exceed LIVE_RESTART_MAX_SECONDS")
    state = args.state_dir.resolve()
    common = {**env, "HOST": "127.0.0.1", "LLM_MODE": "live", "LLM_API_KEY": "",
              "ANALYSIS_ENABLED": "1" if args.with_llm else "0", "CONTEXT_MODE": "existing",
              "CONTEXT_DB": str(database), "DATA_DIR": str(data), "NEWS_SEED_MODE": "none",
              "NEWS_ENABLED": "0", "NEWS_POLL_SECONDS": str(poll), "NEWS_FULL_TEXT_ENABLED": "1",
              "LIVE_PIPELINE_ENABLED": "0", "RANK_MODE": "news-analysis",
              "NEWS_MODULE_PATH": str(root), "RETRIEVAL_MODE": "http", "AGENT_MODE": "http",
              "ML_URL": f"http://127.0.0.1:{ports['ml']}",
              "RETRIEVAL_URL": f"http://127.0.0.1:{ports['retrieval']}",
              "AGENT_URL": f"http://127.0.0.1:{ports['agent']}"}
    # No mock process, fixture creation or implicit demo news in this entry point.
    commands = [
        ("ml", [sys.executable, "-m", "uvicorn", "integration.app:app", "--host", "127.0.0.1",
                "--port", str(ports["ml"])], {}),
        ("retrieval", ["node", "dist/integration/provider-server.js"],
         {"SERVICE_KIND": "retrieval", "NEWS_ENABLED": "1"}),
        ("agent", ["node", "dist/integration/provider-server.js"],
         {"SERVICE_KIND": "agent", "LLM_API_KEY": env.get("LLM_API_KEY", "") if args.with_llm else ""}),
        ("gateway", ["node", "dist/integration/index.js"], {"LIVE_PIPELINE_ENABLED": "1"}),
    ]
    services = [{"name": name, "command": command,
                 "environment": {**common, **overrides, "PORT": str(ports[name]),
                                 "DB_PATH": str(state / (name + ".sqlite3"))}}
                for name, command, overrides in commands]
    return {"state": state, "ports": ports, "services": services, "feed_count": len(feeds),
            "llm_enabled": args.with_llm, "poll_seconds": poll, "supervisor": supervisor}


def check_runtime(plan, root=ROOT):
    for path in ["dist/integration/index.js", "dist/integration/provider-server.js"]:
        if not (root / path).is_file():
            raise ValueError("Run npm ci and npm run build before starting scripts/live.py")
    sys.path.insert(0, str(root))
    from company_context import ContextStore
    try:
        with ContextStore(plan["services"][0]["environment"]["CONTEXT_DB"]) as store:
            if not store.list_companies(limit=1):
                raise ValueError("empty")
    except Exception:
        raise ValueError("--context-db is empty or not a compatible company-context database") from None
    node_check = ("import {loadSettings} from './dist/config.js'; "
                  "const [major,minor]=process.versions.node.split('.').map(Number); "
                  "if(major!==24||minor<13)throw Error('Node 24.13+ required'); loadSettings();")
    for service in plan["services"]:
        if service["name"] not in {"agent", "retrieval"}:
            continue
        try:
            subprocess.run(["node", "--input-type=module", "-e", node_check], cwd=root,
                           env=service["environment"], capture_output=True, text=True, check=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            raise ValueError("Invalid Node service configuration; check Node.js 24, build and LLM/NEWS settings") from None


@contextmanager
def runtime_lock(state):
    state.mkdir(parents=True, exist_ok=True)
    with (state / "runtime.lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("This --state-dir is already in use by another local runner") from None
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def check_ports(ports):
    sockets = []
    try:
        for port in ports.values():
            try:
                # macOS may allow a reusable loopback bind beside an existing
                # wildcard listener. Probe before reserving the port; only a
                # refused connection confirms that no server is accepting it.
                probe = socket.socket()
                try:
                    probe.settimeout(0.2)
                    if probe.connect_ex(("127.0.0.1", port)) != errno.ECONNREFUSED:
                        raise OSError("Port is listening or its availability could not be established")
                finally:
                    probe.close()
                sock = socket.socket()
                sockets.append(sock)
                # Match the HTTP servers: completed connections can remain in TIME_WAIT
                # after a clean shutdown, without another process owning the port.
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind(("127.0.0.1", port))
                # Reserve the address until the remaining ports have been checked.
                sock.listen(1)
            except OSError:
                raise ValueError(f"Local port {port} is unavailable; stop the earlier service or change its port") from None
    finally:
        for sock in sockets:
            sock.close()


def stop_services(processes, grace=10):
    # Stop gateway/worker first while its agent and retrieval dependencies are alive.
    for process in reversed(processes):
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def service_healthy(port):
    try:
        with urlopen(f"http://127.0.0.1:{port}/v1/health", timeout=0.3) as response:
            return response.status == 200
    except OSError:
        return False


class Supervisor:
    """Restart only owned children; preserve state and let expired worker leases recover jobs."""
    def __init__(self, plan, root=ROOT, clock=time.monotonic, wall_clock=time.time):
        self.plan, self.root, self.clock, self.wall_clock = plan, root, clock, wall_clock
        self.rows = [{"service": service, "process": None, "log": None, "status": "stopped",
                      "restarts": 0, "failures": 0, "started": None, "next_restart": None,
                      "last_exit_code": None, "last_error": None, "last_health": None,
                      "unhealthy_since": None} for service in plan["services"]]
        self.log = None
        self.stopping = False

    def _event(self, row, message):
        if self.log is not None:
            self.log.write(datetime.fromtimestamp(self.wall_clock(), timezone.utc).isoformat()
                           + " " + row["service"]["name"] + " " + message + "\n")
            self.log.flush()

    def _spawn(self, row):
        service = row["service"]
        if row["log"] is None:
            row["log"] = (self.plan["state"] / (service["name"] + ".log")).open("a", encoding="utf-8")
        row["process"] = subprocess.Popen(service["command"], cwd=self.root,
                                           env=service["environment"], stdout=row["log"], stderr=subprocess.STDOUT,
                                           # Terminal Ctrl+C must reach the supervisor first, so it
                                           # can drain gateway before stopping its dependencies.
                                           start_new_session=True)
        row.update(status="starting", started=self.clock(), next_restart=None,
                   last_health=None, unhealthy_since=None)
        self._event(row, "started")

    def start(self):
        self.log = (self.plan["state"] / "supervisor.log").open("a", encoding="utf-8")
        for row in self.rows:
            self._spawn(row)
        self.snapshot()

    def _retry(self, row, reason):
        row["failures"] += 1
        config = self.plan["supervisor"]
        delay = min(config["restart_max"], config["restart_base"] * 2 ** min(row["failures"] - 1, 16))
        row.update(status="backoff", next_restart=self.clock() + delay, last_error=reason)
        self._event(row, reason + "; retry in " + str(delay) + " seconds")

    def tick(self):
        if self.stopping:
            return
        now, config = self.clock(), self.plan["supervisor"]
        for row in self.rows:
            process = row["process"]
            if process is not None and process.poll() is not None:
                row["last_exit_code"] = process.returncode
                row["process"] = None
                self._retry(row, "child exited")
            if row["process"] is None:
                if row["next_restart"] is None or now < row["next_restart"]:
                    continue
                # If an unrelated listener took the port, report/back off. Never terminate it.
                try:
                    check_ports({row["service"]["name"]: self.plan["ports"][row["service"]["name"]]})
                    self._spawn(row)
                    row["restarts"] += 1
                except (OSError, ValueError):
                    self._retry(row, "restart unavailable; inspect port and service configuration")
                continue
            if row["last_health"] is None or now - row["last_health"] >= 5:
                row["last_health"] = now
                if service_healthy(self.plan["ports"][row["service"]["name"]]):
                    row.update(status="running", unhealthy_since=None, last_error=None)
                    if now - row["started"] >= config["stable_seconds"]:
                        row["failures"] = 0
                else:
                    if row["unhealthy_since"] is None:
                        row["unhealthy_since"] = now
                    row["status"] = "starting" if now - row["started"] < config["startup_timeout"] else "unhealthy"
            if row["unhealthy_since"] is not None and now - row["unhealthy_since"] >= config["startup_timeout"]:
                stop_services([row["process"]], grace=min(config["shutdown_grace"], 5))
                row["last_exit_code"] = row["process"].returncode
                row["process"] = None
                self._retry(row, "health check timed out")
        self.snapshot()

    def snapshot(self):
        now, wall = self.clock(), self.wall_clock()
        def date(value):
            return datetime.fromtimestamp(value, timezone.utc).isoformat() if value is not None else None
        value = {"updated_at": date(wall), "stopping": self.stopping, "worker_location": "gateway",
                 "services": [{"name": row["service"]["name"], "pid": row["process"].pid if row["process"] else None,
                               "status": row["status"], "restarts": row["restarts"], "consecutive_failures": row["failures"],
                               "last_exit_code": row["last_exit_code"], "last_error": row["last_error"],
                               "next_restart_at": date(wall + row["next_restart"] - now) if row["next_restart"] is not None else None}
                              for row in self.rows]}
        temp = self.plan["state"] / "supervisor-status.json.tmp"
        temp.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        temp.replace(self.plan["state"] / "supervisor-status.json")

    def close(self):
        self.stopping = True
        try:
            stop_services([row["process"] for row in self.rows if row["process"] is not None],
                          grace=self.plan["supervisor"]["shutdown_grace"])
        finally:
            for row in self.rows:
                row.update(process=None, status="stopped", next_restart=None)
                if row["log"] is not None:
                    row["log"].close()
            self.snapshot()
            if self.log is not None:
                self.log.close()


def run(plan, root=ROOT):
    with runtime_lock(plan["state"]):
        check_ports(plan["ports"])
        supervisor = Supervisor(plan, root)
        try:
            supervisor.start()
            announced = False
            while True:
                supervisor.tick()
                if not announced and all(row["status"] == "running" for row in supervisor.rows):
                    print(f"Open http://127.0.0.1:{plan['ports']['gateway']}/live/", flush=True)
                    print(f"News polling: {plan['feed_count']} configured sources, every {plan['poll_seconds']} seconds.", flush=True)
                    print("LLM generation: " + ("enabled; provider calls can incur charges" if plan["llm_enabled"]
                                                 else "disabled; collection, ranking and durable queue continue"), flush=True)
                    print(f"Persistent state and logs: {plan['state']}. Worker runs inside gateway; Ctrl+C drains/stops services.", flush=True)
                    announced = True
                time.sleep(0.5)
        finally:
            supervisor.close()


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        plan = runtime_plan(args, os.environ)
        check_runtime(plan)
        if args.check:
            print(json.dumps({"configuration_valid": True, "services": list(plan["ports"]),
                              "feed_count": plan["feed_count"], "llm_enabled": plan["llm_enabled"],
                              "external_requests_made": False}))
            return 0
        def stopping(*_):
            raise KeyboardInterrupt()
        signal.signal(signal.SIGTERM, stopping)
        run(plan)
    except KeyboardInterrupt:
        return 0
    except (ValueError, RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
