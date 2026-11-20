#!/usr/bin/env python3
"""Metered endpoint for isolated Growth Partner model acceptance."""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import sqlite3
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

MODEL = "deepseek-flash"
PROVIDER_URL = "https://api.deepseek.com/chat/completions"
ROUTE = "/v1/chat/completions"
NANODOLLARS_PER_DOLLAR = 1_000_000_000
SPEND_LIMIT = 3 * NANODOLLARS_PER_DOLLAR
INPUT_PRICE = 300  # $0.30 per million input tokens, at the peak cache-miss rate
OUTPUT_PRICE = 1200  # $1.20 per million output tokens at the peak rate
PROVIDER_CONTEXT = 1_048_576  # Conservative upper bound for the documented 1M-token context
MAX_OUTPUT = 900
MAX_CALLS = 432
MAX_BODY = 64 * 1024
MAX_REPLY = 512 * 1024
LEDGER_ID = 0x49415141
LEDGER_VERSION = 1

SCENARIOS = {
    "grounding": (6, 1, 8192),
    "intake": (6, 1, 8192),
    "recovery": (6, 1, 8192),
    "tools": (21, 6, 12000),
}
FIXTURE_ID = re.compile(r"(grounding|intake|recovery|tools)-([0-9]{2})-r([1-3])")
FUNCTION_NAME = re.compile(r"[A-Za-z0-9_-]{1,64}")
FIELDS = {"model", "messages", "tools", "tool_choice", "max_tokens", "max_completion_tokens",
          "stream", "stream_options", "temperature", "top_p", "thinking"}
Transport = Callable[[bytes], tuple[int, bytes]]


class Refusal(Exception):
    def __init__(self, code: str, status: int = 400):
        super().__init__(code)
        self.code = code
        self.status = status


def _scenario(fixture: str) -> tuple[str, int, int]:
    match = FIXTURE_ID.fullmatch(fixture)
    if not match:
        raise Refusal("invalid_fixture", 401)
    category, number, _repetition = match.groups()
    count, calls, input_limit = SCENARIOS[category]
    if not 1 <= int(number) <= count:
        raise Refusal("invalid_fixture", 401)
    return category, calls, input_limit


def fixture_token(secret: bytes, fixture: str) -> str:
    """Derive the OpenAI-compatible Bearer token for one approved synthetic fixture run."""
    _scenario(fixture)
    signature = hmac.new(secret, fixture.encode("ascii"), hashlib.sha256).hexdigest()
    return fixture + "." + signature


def _json(data: bytes) -> Any:
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON keys")
            result[key] = value
        return result

    def reject_constant(_name: str) -> Any:
        raise ValueError("non-JSON constant")

    return json.loads(data.decode("utf-8"), object_pairs_hook=unique, parse_constant=reject_constant)


def _encoded(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


class Ledger:
    """An explicitly initialized SQLite campaign with one in-flight charge across processes."""

    def __init__(self, path: Path, campaign: str, *, binding: str = "synthetic", spend_limit: int = SPEND_LIMIT):
        validate_campaign(campaign, spend_limit)
        self.path = path.resolve()
        self.policy = (campaign, binding, MODEL, INPUT_PRICE, OUTPUT_PRICE, PROVIDER_CONTEXT, spend_limit)
        self.spend_limit = spend_limit
        with closing(self._connect()) as db:
            self._check_policy(db)

    @classmethod
    def initialize(cls, path: Path, campaign: str, *, binding: str = "synthetic", spend_limit: int = SPEND_LIMIT) -> Ledger:
        validate_campaign(campaign, spend_limit)
        path = path.resolve()
        with path.open("xb"):
            pass
        with closing(_open_ledger(path, "rw")) as db, db:
            db.execute(f"pragma application_id = {LEDGER_ID}")
            db.execute(f"pragma user_version = {LEDGER_VERSION}")
            db.execute("""create table policy (
                id integer primary key check (id = 1), campaign text not null, binding text not null,
                model text not null, input_price integer not null, output_price integer not null,
                context_tokens integer not null, spend_limit integer not null, halted text
            )""")
            db.execute("""create table attempts (
                id integer primary key, fixture text not null, cost integer not null,
                state text not null check (state in ('reserved','settled','retained')),
                input_tokens integer, output_tokens integer, error text
            )""")
            db.execute("insert into policy values(1, ?, ?, ?, ?, ?, ?, ?, null)",
                       (campaign, binding, MODEL, INPUT_PRICE, OUTPUT_PRICE, PROVIDER_CONTEXT, spend_limit))
        return cls(path, campaign, binding=binding, spend_limit=spend_limit)

    def _connect(self) -> sqlite3.Connection:
        db = _open_ledger(self.path, "rw")
        db.execute("pragma synchronous = FULL")
        return db

    def _check_policy(self, db: sqlite3.Connection) -> None:
        _check_format(db)
        saved = db.execute(
            "select campaign, binding, model, input_price, output_price, context_tokens, spend_limit from policy where id = 1"
        ).fetchone()
        if saved != self.policy:
            raise sqlite3.DatabaseError("acceptance ledger policy mismatch")

    def reserve(self, fixture: str, output: int) -> int:
        _category, maximum, _input_limit = _scenario(fixture)
        if type(output) is not int or not 1 <= output <= MAX_OUTPUT:
            raise Refusal("invalid_output_limit")
        cost = PROVIDER_CONTEXT * INPUT_PRICE + output * OUTPUT_PRICE
        with closing(self._connect()) as db, db:
            db.execute("begin immediate")
            self._check_policy(db)
            halted = db.execute("select halted from policy where id = 1").fetchone()[0]
            if halted:
                raise Refusal("campaign_stopped", 409)
            if db.execute("select 1 from attempts where state = 'reserved' limit 1").fetchone():
                raise Refusal("charge_already_reserved", 409)
            count = db.execute("select count(*) from attempts where fixture = ?", (fixture,)).fetchone()[0]
            if count >= maximum:
                raise Refusal("fixture_call_limit", 429)
            total_calls, total_cost = db.execute("select count(*), coalesce(sum(cost), 0) from attempts").fetchone()
            if total_calls >= MAX_CALLS or total_cost + cost > self.spend_limit:
                db.execute("update policy set halted = 'campaign_budget' where id = 1")
                db.commit()
                raise Refusal("campaign_budget", 429)
            row = db.execute("insert into attempts(fixture, cost, state) values(?, ?, 'reserved')", (fixture, cost))
            return row.lastrowid

    def settle(self, attempt: int, input_tokens: int, output_tokens: int) -> None:
        with closing(self._connect()) as db, db:
            self._check_policy(db)
            cost = input_tokens * INPUT_PRICE + output_tokens * OUTPUT_PRICE
            row = db.execute(
                """update attempts set cost = ?, input_tokens = ?, output_tokens = ?, state = 'settled'
                   where id = ? and state = 'reserved' and cost >= ?""",
                (cost, input_tokens, output_tokens, attempt, cost),
            )
            if row.rowcount != 1:
                raise RuntimeError("acceptance charge could not be settled")

    def stop(self, attempt: int, code: str) -> None:
        with closing(self._connect()) as db, db:
            self._check_policy(db)
            db.execute("update policy set halted = coalesce(halted, ?) where id = 1", (code,))
            db.execute(
                "update attempts set state = 'retained', error = ? where id = ? and state = 'reserved'",
                (code, attempt),
            )

def validate_campaign(campaign: str, spend_limit: int) -> None:
    if not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", campaign):
        raise ValueError("invalid acceptance campaign ID")
    if type(spend_limit) is not int or not 0 < spend_limit <= SPEND_LIMIT:
        raise ValueError("invalid acceptance spend ceiling")


def _open_ledger(path: Path, mode: str) -> sqlite3.Connection:
    return sqlite3.connect(path.as_uri() + "?mode=" + mode, uri=True, timeout=5)


def _check_format(db: sqlite3.Connection) -> None:
    if (db.execute("pragma application_id").fetchone()[0] != LEDGER_ID
            or db.execute("pragma user_version").fetchone()[0] != LEDGER_VERSION):
        raise sqlite3.DatabaseError("unrecognized acceptance ledger")


def read_report(path: Path, campaign: str) -> dict[str, Any]:
    with closing(_open_ledger(path.resolve(), "ro")) as db:
        db.execute("begin")
        _check_format(db)
        db.row_factory = sqlite3.Row
        policy = db.execute(
            "select campaign, model, spend_limit, halted from policy where id = 1 and campaign = ?", (campaign,)
        ).fetchone()
        if policy is None or policy["model"] != MODEL:
            raise sqlite3.DatabaseError("acceptance campaign mismatch")
        attempts = db.execute(
            "select id, fixture, cost, state, input_tokens, output_tokens, error from attempts order by id"
        ).fetchall()
        totals = {state: sum(row["cost"] for row in attempts if row["state"] == state)
                  for state in ("settled", "retained", "reserved")}
        return {"campaign": campaign, "model": policy["model"], "budgetNanodollars": policy["spend_limit"],
                "usedNanodollars": sum(totals.values()), "accountingNanodollars": totals,
                "dispatchBlocked": bool(policy["halted"] or totals["reserved"]), "halted": policy["halted"],
                "attempts": [dict(row) for row in attempts]}


def _function_call(value: Any, names: set[str]) -> bool:
    if not isinstance(value, dict) or not {"id", "type", "function"} <= value.keys() <= {"id", "type", "function", "index"}:
        return False
    function = value["function"]
    return (value["type"] == "function"
            and ("index" not in value or type(value["index"]) is int)
            and isinstance(value["id"], str) and 0 < len(value["id"]) <= 128
            and isinstance(function, dict) and function.keys() == {"name", "arguments"}
            and isinstance(function["name"], str) and function["name"] in names
            and isinstance(function["arguments"], str))


def _tool_names(value: Any) -> set[str]:
    if not isinstance(value, list) or len(value) > 64:
        raise Refusal("invalid_tools")
    names: set[str] = set()
    for tool in value:
        if not isinstance(tool, dict) or tool.keys() != {"type", "function"} or tool["type"] != "function":
            raise Refusal("invalid_tools")
        fn = tool["function"]
        if (not isinstance(fn, dict) or not {"name", "parameters"} <= fn.keys() <= {"name", "parameters", "description"}
                or not isinstance(fn["name"], str) or not FUNCTION_NAME.fullmatch(fn["name"])
                or not isinstance(fn["parameters"], dict)
                or ("description" in fn and not isinstance(fn["description"], str))
                or fn["name"] in names):
            raise Refusal("invalid_tools")
        names.add(fn["name"])
    return names


def _validated_request(raw: bytes, fixture: str) -> tuple[dict[str, Any], bool, bool, set[str]]:
    category, _calls, input_limit = _scenario(fixture)
    try:
        request = _json(raw)
    except (ValueError, RecursionError):
        raise Refusal("invalid_json") from None
    if not isinstance(request, dict) or not request.keys() <= FIELDS or request.get("model") != MODEL:
        raise Refusal("invalid_request")
    stream = request.get("stream", False)
    options = request.get("stream_options", {})
    if (type(stream) is not bool or not isinstance(options, dict) or not options.keys() <= {"include_usage"}
            or type(options.get("include_usage", False)) is not bool or (options and not stream)
            or request.get("thinking", {"type": "disabled"}) != {"type": "disabled"}):
        raise Refusal("invalid_request")
    keys = [name for name in ("max_tokens", "max_completion_tokens") if name in request]
    if len(keys) != 1 or type(request[keys[0]]) is not int or request[keys[0]] < 1:
        raise Refusal("invalid_output_limit")

    names = _tool_names(request.get("tools", []))
    choice = request.get("tool_choice", "auto" if names else "none")
    if not isinstance(choice, str) or choice not in ({"none", "auto", "required"} if names else {"none"}):
        raise Refusal("invalid_tool_choice")
    if category != "tools" and names:
        raise Refusal("tools_outside_fixture")
    messages = request.get("messages")
    if not isinstance(messages, list) or not 1 <= len(messages) <= 80:
        raise Refusal("invalid_messages")
    for message in messages:
        if not isinstance(message, dict):
            raise Refusal("invalid_messages")
        role = message.get("role")
        content = message.get("content")
        if role in ("system", "user") and isinstance(content, str) and message.keys() == {"role", "content"}:
            continue
        if role == "assistant" and {"role", "content"} <= message.keys() <= {"role", "content", "tool_calls"}:
            calls = message.get("tool_calls", [])
            if (isinstance(calls, list) and len(calls) <= 64
                    and all(_function_call(call, names) for call in calls)
                    and (isinstance(content, str) or (content is None and bool(calls)))):
                continue
        if (role == "tool" and names and message.keys() == {"role", "content", "tool_call_id"}
                and isinstance(content, str) and isinstance(message["tool_call_id"], str)
                and 0 < len(message["tool_call_id"]) <= 128):
            continue
        raise Refusal("invalid_messages")
    for key, ceiling in (("temperature", 2), ("top_p", 1)):
        if key in request and (type(request[key]) not in (int, float) or not 0 <= request[key] <= ceiling):
            raise Refusal("invalid_sampling")

    request["max_tokens"] = min(request.pop(keys[0]), MAX_OUTPUT)
    request["stream"] = False
    request.pop("stream_options", None)
    request["thinking"] = {"type": "disabled"}
    try:
        size = len(_encoded(request))
    except (ValueError, RecursionError):
        raise Refusal("invalid_request") from None
    # The input budget screens the full serialized text, including tool schemas and history.
    # The durable reservation separately covers the provider's entire documented context.
    if size > input_limit:
        raise Refusal("input_budget")
    return request, stream, options.get("include_usage", False), names if choice != "none" else set()


def _verified_reply(body: bytes, *, fixture: str, output_limit: int, names: set[str]) -> dict[str, Any]:
    if len(body) > MAX_REPLY:
        raise Refusal("provider_response_too_large", 502)
    try:
        reply = _json(body)
    except (ValueError, RecursionError):
        raise Refusal("provider_response_invalid", 502) from None
    if not isinstance(reply, dict) or reply.get("model") != MODEL or not isinstance(reply.get("id"), str):
        raise Refusal("provider_response_invalid", 502)
    usage = reply.get("usage")
    if not isinstance(usage, dict):
        raise Refusal("provider_usage_missing", 502)
    prompt, completion, total = (usage.get(name) for name in ("prompt_tokens", "completion_tokens", "total_tokens"))
    if any(type(value) is not int for value in (prompt, completion, total)):
        raise Refusal("provider_usage_invalid", 502)
    if not (0 < prompt <= _scenario(fixture)[2] and 0 <= completion <= output_limit and total == prompt + completion):
        raise Refusal("provider_usage_out_of_bounds", 502)

    choices = reply.get("choices")
    if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
        raise Refusal("provider_response_invalid", 502)
    choice = choices[0]
    message = choice.get("message")
    reason = choice.get("finish_reason")
    if (choice.get("index") != 0 or not isinstance(message, dict) or message.get("role") != "assistant"
            or not message.keys() <= {"role", "content", "tool_calls", "reasoning_content"}
            or message.get("reasoning_content") not in (None, "")
            or reason not in ("stop", "length", "tool_calls")):
        raise Refusal("provider_response_invalid", 502)
    content = message.get("content")
    calls = message.get("tool_calls")
    if calls is None:
        calls = []
    if (not isinstance(calls, list) or len(calls) > 64 or bool(calls) != (reason == "tool_calls")
            or not all(_function_call(call, names) for call in calls)
            or not (isinstance(content, str) or (content is None and calls))):
        raise Refusal("provider_response_invalid", 502)
    clean_message = {"role": "assistant", "content": content}
    if calls:
        clean_message["tool_calls"] = calls
    clean_usage = {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": total}
    return {"id": reply["id"], "model": MODEL, "object": "chat.completion",
            "created": reply["created"] if type(reply.get("created")) is int else 0,
            "choices": [{"index": 0, "message": clean_message, "finish_reason": reason}], "usage": clean_usage}


def _stream_reply(reply: dict[str, Any], include_usage: bool) -> bytes:
    def event(choices: list[dict[str, Any]], **extra: Any) -> bytes:
        chunk = {name: reply[name] for name in ("id", "model", "created")}
        chunk.update(object="chat.completion.chunk", choices=choices, **extra)
        return b"data: " + _encoded(chunk) + b"\n\n"

    choice = reply["choices"][0]
    delta = dict(choice["message"])
    if "tool_calls" in delta:
        delta["tool_calls"] = [{**call, "index": index} for index, call in enumerate(delta["tool_calls"])]
    parts = [event([{"index": 0, "delta": delta, "finish_reason": None}]),
             event([{"index": 0, "delta": {}, "finish_reason": choice["finish_reason"]}])]
    if include_usage:
        parts.append(event([], usage=reply["usage"]))
    return b"".join(parts) + b"data: [DONE]\n\n"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None


def deepseek_transport(key: str) -> Transport:
    """One fixed TLS origin, with environment proxies and redirects disabled."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def forward(body: bytes) -> tuple[int, bytes]:
        request = urllib.request.Request(
            PROVIDER_URL, body, method="POST",
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                     "Accept": "application/json", "User-Agent": "iAcquireModelAcceptance/1"},
        )
        try:
            with opener.open(request, timeout=25) as response:
                return response.status, response.read(MAX_REPLY + 1)
        except urllib.error.HTTPError as error:
            error.close()
            return error.code, b""

    return forward


def make_server(ledger: Ledger, secret: bytes, transport: Transport, port: int) -> ThreadingHTTPServer:
    if len(secret) < 32:
        raise ValueError("acceptance broker secret must have at least 32 bytes")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *args: Any) -> None:
            return

        def setup(self) -> None:
            self.request.settimeout(10)
            super().setup()

        def _send(self, status: int, body: bytes, content_type: str = "application/json") -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _call(self, raw: bytes, fixture: str) -> tuple[bytes, str]:
            request, stream, include_usage, names = _validated_request(raw, fixture)
            attempt = ledger.reserve(fixture, request["max_tokens"])
            try:
                status, body = transport(_encoded(request))
                if status != 200:
                    error = ("provider_redirect" if 300 <= status < 400 else
                             "provider_quota" if status in (402, 429) else "provider_http")
                    raise Refusal(error, 502)
                reply = _verified_reply(body, fixture=fixture, output_limit=request["max_tokens"], names=names)
                payload = (_stream_reply(reply, include_usage), "text/event-stream") if stream else (_encoded(reply), "application/json")
                usage = reply["usage"]
                ledger.settle(attempt, usage["prompt_tokens"], usage["completion_tokens"])
                return payload
            except Refusal as error:
                ledger.stop(attempt, error.code)
                raise
            except Exception:
                ledger.stop(attempt, "provider_transport_or_accounting_failed")
                raise Refusal("provider_transport_or_accounting_failed", 502) from None

        def do_POST(self) -> None:
            try:
                if self.path != ROUTE:
                    raise Refusal("unknown_route", 404)
                supplied = self.headers.get_all("Authorization", [])
                if len(supplied) != 1 or not supplied[0].startswith("Bearer "):
                    raise Refusal("invalid_fixture_token", 401)
                token = supplied[0][7:]
                fixture = token.partition(".")[0]
                if not hmac.compare_digest(token.encode("utf-8"), fixture_token(secret, fixture).encode("ascii")):
                    raise Refusal("invalid_fixture_token", 401)
                lengths = self.headers.get_all("Content-Length", [])
                if (len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,6}", lengths[0])
                        or not 1 <= int(lengths[0]) <= MAX_BODY or "Transfer-Encoding" in self.headers
                        or self.headers.get_content_type() != "application/json"):
                    raise Refusal("invalid_body")
                raw = self.rfile.read(int(lengths[0]))
                if len(raw) != int(lengths[0]):
                    raise Refusal("invalid_body")
                payload, content_type = self._call(raw, fixture)
            except Refusal as error:
                self._send(error.status, _encoded({"error": {"message": error.code, "code": error.code}}))
            except sqlite3.Error:
                self._send(503, _encoded({"error": {"message": "ledger_unavailable", "code": "ledger_unavailable"}}))
            except TimeoutError:
                self._send(408, _encoded({"error": {"message": "request_timeout", "code": "request_timeout"}}))
            else:
                self._send(200, payload, content_type)

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ledger", required=True, type=Path)
    parser.add_argument("--campaign", required=True, help="The approved synthetic campaign's UUID")
    parser.add_argument("--port", type=int, default=8786)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--initialize", action="store_true", help="Create the one persistent ledger for an approved paid campaign")
    mode.add_argument("--report", action="store_true")
    args = parser.parse_args()
    if args.report:
        try:
            print(json.dumps(read_report(args.ledger, args.campaign)))
        except (sqlite3.Error, ValueError):
            parser.error("the identified acceptance ledger could not be read")
        return
    secret = os.environ.get("IACQUIRE_ACCEPTANCE_BROKER_SECRET", "").encode("utf-8")
    key = os.environ.get("IACQUIRE_ACCEPTANCE_UPSTREAM_KEY", "")
    if not key or len(secret) < 32:
        parser.error("isolated acceptance credentials are required")
    binding = hmac.new(secret, key.encode("utf-8"), hashlib.sha256).hexdigest()
    try:
        if args.initialize:
            Ledger.initialize(args.ledger, args.campaign, binding=binding)
            print("Initialized the campaign budget ledger.", flush=True)
            return
        ledger = Ledger(args.ledger, args.campaign, binding=binding)
    except (OSError, sqlite3.Error, ValueError):
        parser.error("the identified acceptance ledger could not be opened for this campaign")
    with make_server(ledger, secret, deepseek_transport(key), args.port) as server:
        print(f"Growth Partner acceptance meter on 127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever(poll_interval=0.25)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
