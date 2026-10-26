"""Prepare/review a single event and explicitly generate through the local gateway. No API keys here."""
import argparse
import json
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["context", "analyze"])
    parser.add_argument("--request", required=True, help="AnalysisEventRequest, Event or RankRequest JSON")
    parser.add_argument("--news-id")
    parser.add_argument("--company-id")
    parser.add_argument("--as-of")
    parser.add_argument("--role", choices=["cfo", "ceo", "treasury"])
    parser.add_argument("--context-file", help="Previously reviewed context; required for analyze")
    parser.add_argument("--base", default="http://127.0.0.1:8000")
    parser.add_argument("--output")
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()
    if args.timeout < 1:
        parser.error("--timeout must be positive")
    data = json.loads(Path(args.request).read_text(encoding="utf-8-sig"))
    events = data.get("events", [data.get("event", data)])
    if args.news_id:
        events = [event for event in events if event.get("news_id") == args.news_id]
    if len(events) != 1:
        parser.error("Select exactly one event with --news-id")
    body = {"company_id": args.company_id or data.get("company_id"), "event": events[0],
            "as_of": args.as_of or data.get("as_of"), "audience_role": args.role or data.get("audience_role", "cfo")}
    if not body["company_id"] or not body["as_of"]:
        parser.error("Specify company_id/as_of in JSON or --company-id and --as-of")
    if args.command == "analyze":
        if not args.context_file:
            parser.error("First run context, review it and pass --context-file")
        preview = json.loads(Path(args.context_file).read_text(encoding="utf-8-sig"))["data"]
        for key in ["company_id", "event", "as_of", "audience_role"]:
            if body[key] != preview["input"][key]:
                parser.error("Request differs from reviewed context; prepare a new context")
        body["expected_context_sha256"] = preview["sha256"]
    destination = Path(args.output or ("var/llm/context.json" if args.command == "context" else "var/llm/answer.json"))
    protected = [Path(args.request).resolve()]
    if args.context_file:
        protected.append(Path(args.context_file).resolve())
    if destination.resolve() in protected:
        parser.error("Output must not overwrite the request or reviewed context")
    request = Request(args.base.rstrip("/") + ("/v1/analysis-context" if args.command == "context" else "/v1/analyze-event"),
                      headers={"Content-Type": "application/json"}, data=json.dumps(body).encode())
    try:
        with urlopen(request, timeout=args.timeout) as response:
            value = json.load(response)
    except HTTPError as error:
        with error:
            value = json.load(error)
        parser.exit(1, f"[{value.get('error', {}).get('code', error.code)}] {value.get('error', {}).get('message', 'Request failed')}\n")
    except (URLError, TimeoutError):
        parser.exit(1, "Gateway недоступен или истекло время ожидания. Запустите scripts/dev.py и проверьте --base.\n")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(destination)


if __name__ == "__main__":
    main()
