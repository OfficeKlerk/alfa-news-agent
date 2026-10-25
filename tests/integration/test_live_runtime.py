"""The real local entry point must never silently fall back to fixtures or paid calls."""
import importlib.util
import errno
import json
from pathlib import Path
import socket
from unittest.mock import Mock

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("live_runner", ROOT / "scripts/live.py")
live = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(live)


@pytest.fixture
def setup(tmp_path):
    database = tmp_path / "companies.sqlite"
    database.write_bytes(b"existing database; tests below only construct the plan")
    data = tmp_path / "data"
    data.mkdir()
    args = live.parser().parse_args(["--context-db", str(database), "--data-dir", str(data),
                                    "--state-dir", str(tmp_path / "state")])
    return args, {"NEWS_FEEDS_JSON": '["https://example.org/rss"]'}, tmp_path


def services(plan):
    return {row["name"]: row for row in plan["services"]}


def test_real_runner_overrides_demo_configuration_and_isolates_state(setup):
    args, env, root = setup
    env.update(LLM_MODE="demo", RANK_MODE="mock", RETRIEVAL_MODE="mock", AGENT_MODE="mock",
               CONTEXT_MODE="fixture", NEWS_SEED_MODE="reviewed", LLM_API_KEY="secret-not-for-demo")
    plan = live.runtime_plan(args, env, root)
    rows = services(plan)
    assert set(rows) == {"gateway", "ml", "retrieval", "agent"}
    assert plan["llm_enabled"] is False
    assert plan["poll_seconds"] == 300
    assert len({row["environment"]["DB_PATH"] for row in rows.values()}) == 4
    for row in rows.values():
        current = row["environment"]
        assert current["CONTEXT_MODE"] == "existing"
        assert current["CONTEXT_DB"] == str(args.context_db)
        assert current["NEWS_SEED_MODE"] == "none"
        assert current["RANK_MODE"] == "news-analysis"
        assert current["NEWS_MODULE_PATH"] == str(root)
        assert current["RETRIEVAL_MODE"] == current["AGENT_MODE"] == "http"
        assert current["LLM_MODE"] == "live"
        assert current["LLM_API_KEY"] == ""
        assert current["ANALYSIS_ENABLED"] == "0"
        assert current["HOST"] == "127.0.0.1"
        assert "mock-server" not in " ".join(row["command"])
    assert [row["name"] for row in rows.values() if row["environment"]["NEWS_ENABLED"] == "1"] == ["retrieval"]
    assert not args.state_dir.exists(), "Planning must not create runtime databases or fixtures"


def test_llm_credentials_only_reach_agent_after_explicit_flag(setup):
    args, env, root = setup
    args.with_llm = True
    with pytest.raises(ValueError, match="LLM_API_KEY"):
        live.runtime_plan(args, env, root)
    env["LLM_API_KEY"] = "sensitive-key"
    rows = services(live.runtime_plan(args, env, root))
    assert rows["agent"]["environment"]["LLM_API_KEY"] == "sensitive-key"
    assert rows["gateway"]["environment"]["LLM_API_KEY"] == ""
    assert rows["retrieval"]["environment"]["LLM_API_KEY"] == ""
    assert rows["ml"]["environment"]["LLM_API_KEY"] == ""
    assert all(row["environment"]["ANALYSIS_ENABLED"] == "1" for row in rows.values())


def test_node_dotenv_parser_and_shell_precedence(setup):
    args, env, root = setup
    path = root / "private.env"
    path.write_text("# no shell expansion\nexport NEWS_POLL_SECONDS=600\n"
                    "LLM_API_KEY='a $literal $(not-a-command)'\n"
                    "NEWS_FEEDS_JSON='[\"https://example.org/rss\"]'\n", encoding="utf-8")
    args.env_file = path
    values = live.read_environment(path, {"NEWS_POLL_SECONDS": "900"}, root)
    assert values["NEWS_POLL_SECONDS"] == "900"
    assert values["LLM_API_KEY"] == "a $literal $(not-a-command)"
    assert json.loads(values["NEWS_FEEDS_JSON"]) == ["https://example.org/rss"]
    plan = live.runtime_plan(args, {}, root)
    assert plan["poll_seconds"] == 600
    assert plan["llm_enabled"] is False
    assert all(row["environment"]["LLM_API_KEY"] == "" for row in plan["services"])


def test_source_configuration_fallback_and_explicit_empty_rejected(setup):
    args, env, root = setup
    (root / "config").mkdir()
    (root / "config/news-sources.json").write_text(env["NEWS_FEEDS_JSON"], encoding="utf-8")
    assert live.runtime_plan(args, {}, root)["feed_count"] == 1
    with pytest.raises(ValueError, match="NEWS_FEEDS_JSON"):
        live.runtime_plan(args, {"NEWS_FEEDS_JSON": "[]"}, root)


@pytest.mark.parametrize("feeds", ["[]", "{}", "invalid", '[null]', '["http://example.org/rss"]',
                                     '["https://"]', '["https://user:password@example.org/rss"]'])
def test_missing_or_unsafe_feed_configuration_fails_before_start(setup, feeds):
    args, env, root = setup
    env["NEWS_FEEDS_JSON"] = feeds
    with pytest.raises(ValueError, match="NEWS_FEEDS_JSON"):
        live.runtime_plan(args, env, root)
    assert not args.state_dir.exists()


@pytest.mark.parametrize("changes", [{"PORT": "0"}, {"PORT": "8101"}, {"ML_PORT": "70000"},
                                      {"NEWS_POLL_SECONDS": "0"}, {"NEWS_POLL_SECONDS": "no"}])
def test_bad_ports_and_intervals_fail_before_start(setup, changes):
    args, env, root = setup
    env.update(changes)
    with pytest.raises(ValueError):
        live.runtime_plan(args, env, root)


@pytest.mark.parametrize("target", ["http://example.org/v1", "https://user:pw@example.org/v1",
                                     "https://example.org/v1?key=secret", "https://example.org/v1#secret"])
def test_live_llm_requires_safe_url_and_positive_quota(setup, target):
    args, env, root = setup
    args.with_llm = True
    env.update(LLM_API_KEY="key", LLM_BASE_URL=target)
    with pytest.raises(ValueError, match="LLM_BASE_URL"):
        live.runtime_plan(args, env, root)
    env["LLM_BASE_URL"] = "https://example.org/v1"
    env["MAX_DAILY_LLM_CALLS"] = "0"
    with pytest.raises(ValueError, match="MAX_DAILY_LLM_CALLS"):
        live.runtime_plan(args, env, root)


def test_explicit_company_database_is_required_and_not_created(setup):
    args, env, root = setup
    args.context_db.unlink()
    with pytest.raises(ValueError, match="context-db"):
        live.runtime_plan(args, env, root)
    assert not args.context_db.exists()
    with pytest.raises(SystemExit):
        live.parser().parse_args([])


def test_lock_prevents_two_workers_using_one_state_directory(tmp_path):
    state = tmp_path / "persistent"
    with live.runtime_lock(state):
        with pytest.raises(ValueError, match="already in use"):
            with live.runtime_lock(state):
                pytest.fail("A second runner acquired an active lock")
    with live.runtime_lock(state):
        pass


def test_shutdown_stops_all_processes_and_waits_for_exit():
    rows = [Mock(), Mock(), Mock()]
    for row in rows:
        row.poll.return_value = None
    live.stop_services(rows)
    for row in rows:
        row.terminate.assert_called_once()
        row.wait.assert_called_once_with(timeout=10)


def test_partial_startup_failure_stops_already_started_services(setup, monkeypatch):
    args, env, root = setup
    plan = live.runtime_plan(args, env, root)
    child = Mock()
    child.poll.return_value = None
    start = Mock(side_effect=[child, OSError("cannot spawn second service")])
    monkeypatch.setattr(live.subprocess, "Popen", start)
    monkeypatch.setattr(live, "check_ports", lambda _: None)
    with pytest.raises(OSError, match="cannot spawn"):
        live.run(plan, root)
    child.terminate.assert_called_once()
    child.wait.assert_called_once_with(timeout=30)
    # Existing persistent data survives a failed startup, and the lock is released.
    assert args.state_dir.exists()
    with live.runtime_lock(args.state_dir):
        pass


def test_bound_port_is_rejected_and_all_preflight_sockets_close(monkeypatch):
    first_probe, free, second_probe, occupied = Mock(), Mock(), Mock(), Mock()
    first_probe.connect_ex.return_value = second_probe.connect_ex.return_value = errno.ECONNREFUSED
    occupied.bind.side_effect = OSError("address already in use")
    monkeypatch.setattr(live.socket, "socket", Mock(side_effect=[first_probe, free, second_probe, occupied]))
    with pytest.raises(ValueError, match="Local port 8101 is unavailable"):
        live.check_ports({"gateway": 8000, "ml": 8101})
    free.close.assert_called_once()
    occupied.close.assert_called_once()
    first_probe.close.assert_called_once()
    second_probe.close.assert_called_once()


@pytest.mark.parametrize("connect_result", [0, errno.ETIMEDOUT, errno.ENETUNREACH])
def test_port_probe_rejects_listeners_and_uncertain_availability(monkeypatch, connect_result):
    probe = Mock()
    probe.connect_ex.return_value = connect_result
    factory = Mock(return_value=probe)
    monkeypatch.setattr(live.socket, "socket", factory)
    with pytest.raises(ValueError, match="Local port 8000 is unavailable"):
        live.check_ports({"gateway": 8000})
    probe.settimeout.assert_called_once_with(0.2)
    probe.connect_ex.assert_called_once_with(("127.0.0.1", 8000))
    probe.close.assert_called_once()
    factory.assert_called_once()
    probe.bind.assert_not_called()


def listening_socket(host="127.0.0.1"):
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        server.bind((host, 0))
        server.listen(1)
    except PermissionError:
        server.close()
        pytest.skip("This sandbox does not allow loopback TCP sockets")
    server.settimeout(3)
    return server


def test_restart_port_check_accepts_time_wait_after_clean_shutdown():
    # The server actively closes an accepted connection, leaving its listening
    # address in TIME_WAIT even after every application socket is closed.
    with listening_socket() as server:
        port = server.getsockname()[1]
        with socket.create_connection(("127.0.0.1", port), timeout=3) as client:
            connection, _ = server.accept()
            with connection:
                connection.settimeout(3)
                connection.shutdown(socket.SHUT_WR)
                assert client.recv(1) == b""
                client.shutdown(socket.SHUT_WR)
                assert connection.recv(1) == b""
    # Previously a plain bind here falsely reported an occupied port.
    live.check_ports({"gateway": port})
    # The preflight also releases its own listening socket for the actual service.
    with socket.socket() as restarted:
        restarted.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        restarted.bind(("127.0.0.1", port))
        restarted.listen(1)


@pytest.mark.parametrize("host", ["127.0.0.1", "0.0.0.0"])
def test_restart_port_check_still_rejects_a_running_server(host):
    with listening_socket(host) as server:
        port = server.getsockname()[1]
        with pytest.raises(ValueError, match=f"Local port {port} is unavailable"):
            live.check_ports({"gateway": port})


def test_compose_live_has_real_adapters_readonly_context_and_durable_state():
    config = yaml.safe_load((ROOT / "compose.live.yaml").read_text(encoding="utf-8"))
    rows = config["services"]
    assert set(rows) == {"gateway", "ml", "retrieval", "agent"}
    assert rows["ml"]["environment"]["CONTEXT_MODE"] == "existing"
    assert rows["ml"]["environment"]["RANK_MODE"] == "news-analysis"
    mount = next(row for row in rows["ml"]["volumes"] if isinstance(row, dict))
    assert mount["read_only"] is True
    assert mount["bind"]["create_host_path"] is False
    assert "CONTEXT_DB_HOST_PATH:?" in mount["source"]
    assert "NEWS_FEEDS_JSON:?" in rows["retrieval"]["environment"]["NEWS_FEEDS_JSON"]
    assert len(config["volumes"]) == 4
    assert all(row["restart"] == "unless-stopped" and "healthcheck" in row for row in rows.values())
    assert all("ports" not in rows[name] for name in ["ml", "retrieval", "agent"])
    assert rows["gateway"]["ports"][0].startswith("127.0.0.1:")
    for name in ["gateway", "retrieval", "agent"]:
        assert rows[name]["environment"]["NEWS_SEED_MODE"] == "none"
        assert rows[name]["environment"]["LLM_MODE"] == "live"
    assert rows["retrieval"]["environment"]["NEWS_ENABLED"] == "1"
    assert rows["gateway"]["environment"]["LLM_API_KEY"] == ""
    assert rows["retrieval"]["environment"]["LLM_API_KEY"] == ""
    assert rows["agent"]["environment"]["ANALYSIS_ENABLED"] == "${ANALYSIS_ENABLED:-0}"


def test_database_preflight_uses_readonly_context_and_requires_build(setup):
    args, env, root = setup
    plan = live.runtime_plan(args, env, root)
    with pytest.raises(ValueError, match="npm run build"):
        live.check_runtime(plan, root)
    (root / "dist/integration").mkdir(parents=True)
    for name in ["index.js", "provider-server.js"]:
        (root / "dist/integration" / name).write_text("// compiled entry")
    with pytest.raises(ValueError, match="compatible company-context"):
        live.check_runtime(plan, root)


def test_expanded_source_registry_accepts_64_and_rejects_65_or_duplicate_sources(setup):
    args, env, root = setup
    env["NEWS_FEEDS_JSON"] = json.dumps([f"https://source{i}.example/rss" for i in range(64)])
    assert live.runtime_plan(args, env, root)["feed_count"] == 64
    env["NEWS_FEEDS_JSON"] = json.dumps([f"https://source{i}.example/rss" for i in range(65)])
    with pytest.raises(ValueError, match="64"):
        live.runtime_plan(args, env, root)
    env["NEWS_FEEDS_JSON"] = '["https://example.org/rss","https://example.org/rss"]'
    with pytest.raises(ValueError, match="duplicate"):
        live.runtime_plan(args, env, root)


def test_runtime_enables_durable_pipeline_full_text_and_forwards_budgets(setup):
    args, env, root = setup
    env.update(MAX_DAILY_LLM_CALLS="10", MAX_DAILY_LLM_TOKENS="100000", MAX_COMPANY_DAILY_LLM_CALLS="4",
               LIVE_COMPANY_IDS_JSON='["U34911","U4909"]', LIVE_WORKER_CONCURRENCY="3")
    rows = services(live.runtime_plan(args, env, root))
    assert rows["gateway"]["environment"]["LIVE_PIPELINE_ENABLED"] == "1"
    assert all(rows[n]["environment"]["LIVE_PIPELINE_ENABLED"] == "0" for n in ["ml", "agent", "retrieval"])
    assert rows["retrieval"]["environment"]["NEWS_FULL_TEXT_ENABLED"] == "1"
    assert rows["retrieval"]["environment"]["NEWS_FULL_TEXT_MAX_PER_SOURCE"] == "20"
    assert rows["gateway"]["environment"]["LIVE_COMPANY_IDS_JSON"] == '["U34911","U4909"]'
    assert rows["gateway"]["environment"]["LIVE_WORKER_CONCURRENCY"] == "3"
    assert rows["agent"]["environment"]["MAX_DAILY_LLM_CALLS"] == "10"
    assert rows["agent"]["environment"]["MAX_DAILY_LLM_TOKENS"] == "100000"
    assert rows["agent"]["environment"]["LLM_QUESTION_RESERVE_CALLS"] == "2"
    assert rows["agent"]["environment"]["LLM_QUESTION_RESERVE_TOKENS"] == "20000"
    assert rows["agent"]["environment"]["MAX_COMPANY_DAILY_LLM_CALLS"] == "4"


@pytest.mark.parametrize("changes", [
    {"LIVE_SCAN_SECONDS": "0"}, {"LIVE_WORKER_CONCURRENCY": "100"}, {"LIVE_COMPANY_IDS_JSON": "{}"},
    {"LIVE_COMPANY_IDS_JSON": '["A","A"]'}, {"LIVE_COMPANY_IDS_JSON": '["A","B"]', "LIVE_MAX_COMPANIES": "1"},
    {"LIVE_COMPANY_IDS_JSON": '["../bad"]'}, {"NEWS_SOURCE_CONCURRENCY": "0"},
    {"NEWS_FULL_TEXT_MAX_PER_SOURCE": "1000"}, {"LIVE_RESTART_BASE_SECONDS": "30", "LIVE_RESTART_MAX_SECONDS": "2"},
])
def test_bad_live_worker_and_supervisor_settings_fail_before_start(setup, changes):
    args, env, root = setup
    with pytest.raises(ValueError):
        live.runtime_plan(args, {**env, **changes}, root)


class Child:
    def __init__(self, pid, events=None):
        self.pid, self.returncode = pid, None
        self.events = events if events is not None else []

    def poll(self):
        return self.returncode

    def terminate(self):
        self.events.append((self.pid, "terminate"))
        self.returncode = -15

    def wait(self, timeout=None):
        self.events.append((self.pid, "wait", timeout))
        return self.returncode

    def kill(self):
        self.events.append((self.pid, "kill"))
        self.returncode = -9


def supervisor_fixture(setup, monkeypatch):
    args, env, root = setup
    plan = live.runtime_plan(args, {**env, "LLM_API_KEY": "do-not-leak-this"}, root)
    plan["state"].mkdir()
    clock = [0.0]
    children = []

    def spawn(*_args, **_kwargs):
        child = Child(len(children) + 1)
        children.append(child)
        return child

    monkeypatch.setattr(live.subprocess, "Popen", spawn)
    monkeypatch.setattr(live, "check_ports", lambda _: None)
    monkeypatch.setattr(live, "service_healthy", lambda _: True)
    supervisor = live.Supervisor(plan, root, clock=lambda: clock[0], wall_clock=lambda: 1_700_000_000 + clock[0])
    supervisor.start()
    supervisor.tick()
    return supervisor, clock, children, plan


def test_supervisor_restarts_only_crashed_child_preserving_state_and_redacting_status(setup, monkeypatch):
    supervisor, clock, children, plan = supervisor_fixture(setup, monkeypatch)
    marker = plan["state"] / "gateway.sqlite3"
    marker.write_bytes(b"persistent queue")
    try:
        children[1].returncode = 7
        supervisor.tick()
        assert supervisor.rows[1]["status"] == "backoff"
        assert supervisor.rows[1]["next_restart"] == 1
        clock[0] = 1
        supervisor.tick()
        assert len(children) == 5
        assert supervisor.rows[1]["process"] is children[4]
        assert all(supervisor.rows[i]["process"] is children[i] for i in [0, 2, 3])
        assert marker.read_bytes() == b"persistent queue"
        status = (plan["state"] / "supervisor-status.json").read_text()
        assert "do-not-leak-this" not in status
        assert "LLM_API_KEY" not in status
        assert json.loads(status)["services"][1]["restarts"] == 1
        assert all(not children[i].events for i in [0, 2, 3])
    finally:
        supervisor.close()
    assert json.loads((plan["state"] / "supervisor-status.json").read_text())["stopping"] is True


def test_supervisor_backoff_is_bounded_and_resets_after_stable_health(setup, monkeypatch):
    supervisor, clock, children, plan = supervisor_fixture(setup, monkeypatch)
    plan["supervisor"].update(restart_max=4, stable_seconds=10)
    try:
        row = supervisor.rows[0]
        for expected in [1, 2, 4, 4]:
            row["process"].returncode = 1
            supervisor.tick()
            assert row["next_restart"] - clock[0] == expected
            clock[0] = row["next_restart"]
            supervisor.tick()
        clock[0] += 11
        supervisor.tick()
        assert row["failures"] == 0
        row["process"].returncode = 1
        supervisor.tick()
        assert row["next_restart"] - clock[0] == 1
    finally:
        supervisor.close()


def test_supervisor_never_kills_an_unrelated_listener_on_restart(setup, monkeypatch):
    supervisor, clock, children, _ = supervisor_fixture(setup, monkeypatch)
    try:
        children[0].returncode = 1
        supervisor.tick()
        clock[0] = 1
        monkeypatch.setattr(live, "check_ports", Mock(side_effect=ValueError("occupied")))
        supervisor.tick()
        assert len(children) == 4
        assert supervisor.rows[0]["process"] is None
        assert supervisor.rows[0]["status"] == "backoff"
        assert all(not child.events for child in children)
    finally:
        supervisor.close()


def test_unhealthy_owned_child_is_stopped_before_restart(setup, monkeypatch):
    supervisor, clock, children, plan = supervisor_fixture(setup, monkeypatch)
    plan["supervisor"]["startup_timeout"] = 5
    monkeypatch.setattr(live, "service_healthy", lambda port: port != plan["ports"]["gateway"])
    try:
        clock[0] = 5
        supervisor.tick()
        clock[0] = 10
        supervisor.tick()
        assert supervisor.rows[3]["status"] == "backoff"
        assert children[3].events == [(4, "terminate"), (4, "wait", 5)]
        assert all(not children[i].events for i in [0, 1, 2])
    finally:
        supervisor.close()


def test_shutdown_waits_for_gateway_drain_before_stopping_dependencies():
    events = []
    children = [Child(name, events) for name in ["ml", "retrieval", "agent", "gateway"]]
    live.stop_services(children, grace=30)
    assert events == [(name, event, *([30] if event == "wait" else []))
                      for name in ["gateway", "agent", "retrieval", "ml"] for event in ["terminate", "wait"]]


def test_shutdown_kills_only_owned_process_after_its_grace_expires():
    process = Mock()
    process.poll.return_value = None
    process.wait.side_effect = [live.subprocess.TimeoutExpired("owned-child", 2), 0]
    live.stop_services([process], grace=2)
    process.terminate.assert_called_once()
    process.kill.assert_called_once()
    assert process.wait.call_count == 2


def test_real_child_crash_is_restarted_and_shutdown_leaves_persistent_files(setup, monkeypatch):
    args, env, root = setup
    plan = live.runtime_plan(args, env, root)
    plan["services"] = plan["services"][:1]
    plan["ports"] = {"ml": plan["ports"]["ml"]}
    plan["state"].mkdir()
    marker = plan["state"] / "first-run"
    code = ("import pathlib,sys,time; p=pathlib.Path(sys.argv[1]); existed=p.exists(); "
            "p.write_text('keep this state'); sys.exit(7) if not existed else time.sleep(30)")
    plan["services"][0]["command"] = [live.sys.executable, "-c", code, str(marker)]
    plan["supervisor"]["shutdown_grace"] = 2
    monkeypatch.setattr(live, "check_ports", lambda _: None)
    monkeypatch.setattr(live, "service_healthy", lambda _: True)
    clock = [0.0]
    supervisor = live.Supervisor(plan, root, clock=lambda: clock[0])
    try:
        supervisor.start()
        first = supervisor.rows[0]["process"]
        assert first.wait(timeout=5) == 7
        supervisor.tick()
        clock[0] = 1
        supervisor.tick()
        second = supervisor.rows[0]["process"]
        assert second.pid != first.pid
        assert second.poll() is None
        assert live.os.getpgid(second.pid) == second.pid
        assert live.os.getpgid(second.pid) != live.os.getpgrp(), "terminal Ctrl+C must not stop dependencies before gateway drains"
        assert marker.read_text() == "keep this state"
    finally:
        supervisor.close()
    assert second.poll() is not None
    assert marker.exists()


def test_live_example_and_compose_match_source_registry_and_budget_settings():
    sources = json.loads((ROOT / "config/news-sources.json").read_text())
    example = live.read_environment(ROOT / "config/live.env.example", {}, ROOT)
    assert json.loads(example["NEWS_FEEDS_JSON"]) == sources
    assert len(sources) >= 10
    assert example["ANALYSIS_ENABLED"] == "0" and example["LLM_API_KEY"] == ""
    config = yaml.safe_load((ROOT / "compose.live.yaml").read_text())
    rows = config["services"]
    assert rows["gateway"]["environment"]["LIVE_PIPELINE_ENABLED"] == "1"
    assert rows["retrieval"]["environment"]["NEWS_FULL_TEXT_ENABLED"] == "1"
    for setting in ["MAX_DAILY_LLM_TOKENS", "MAX_COMPANY_DAILY_LLM_CALLS", "LLM_QUESTION_RESERVE_CALLS", "LLM_QUESTION_RESERVE_TOKENS"]:
        assert setting in rows["agent"]["environment"]
    assert all(row["stop_grace_period"] == "35s" for row in rows.values())
