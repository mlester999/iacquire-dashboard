import hashlib
import json
import os
import threading
import tempfile
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import acceptance_harness
from acceptance_harness import (
    AcceptanceState,
    EXPECTED_PROFILES,
    PROFILES_PER_TENANT,
    ROLE_TITLES,
    TENANTS,
    _audit_event_diagnostic,
    _hold_fixture_until_shutdown,
    _model_handler,
    _model_request_challenge,
    _portal_status_state,
    _synthetic_model_counters,
    _hermes_memory_chat,
    verify_hermes_memory_after_restart,
)
from verify_portal_acceptance import VerificationError, read_private_text


class AcceptanceFixtureTests(unittest.TestCase):
    def test_hermes_memory_chat_reports_only_safe_transport_or_http_categories(self):
        with patch("acceptance_harness.urllib.request.urlopen", side_effect=urllib.error.HTTPError(
            "http://127.0.0.1:8642/fake", 401, "private body excluded", {}, None,
        )):
            with self.assertRaisesRegex(ValueError, "^hermes_memory_http_401$"):
                _hermes_memory_chat("http://127.0.0.1:8642", "synthetic-profile", "a" * 64, "session", "probe")

        with patch("acceptance_harness.urllib.request.urlopen", side_effect=urllib.error.URLError("private transport detail")):
            with self.assertRaisesRegex(ValueError, "^hermes_memory_transport_error$") as failure:
                _hermes_memory_chat("http://127.0.0.1:8642", "synthetic-profile", "a" * 64, "session", "probe")
        self.assertNotIn("private transport detail", str(failure.exception))

    def test_local_model_fixture_exercises_memory_tool_write_and_recall_protocol(self):
        model_key = "synthetic-model-key-not-for-diagnostics"
        challenge = "0123456789abcdef0123456789abcdef"
        marker = "IACQUIRE_HERMES_MEMORY_0123456789abcdef0123456789abcdef"
        tool = {
            "type": "function",
            "function": {
                "name": "memory",
                "parameters": {"properties": {
                    "action": {"enum": ["add", "patch", "remove"]},
                    "target": {"enum": ["memory", "user"]},
                    "content": {"type": "string"},
                }},
            },
        }
        portal_soul = f"For the private setup check only, return this marker exactly: {challenge}"
        with tempfile.TemporaryDirectory() as directory:
            state = AcceptanceState("00000000-0000-4000-8000-000000000001", Path(directory))
            state.begin_portal_phase()
            server = ThreadingHTTPServer(("127.0.0.1", 0), _model_handler(state, model_key))
            server_thread = threading.Thread(target=server.serve_forever, daemon=True)
            server_thread.start()

            def post(payload):
                body = json.dumps(payload).encode("utf-8")
                request = urllib.request.Request(
                    f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
                    data=body,
                    headers={"Content-Type": "application/json", "Authorization": f"Bearer {model_key}"},
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=2) as response:
                    return response.status, json.loads(response.read())

            def post_stream(payload):
                body = json.dumps(payload).encode("utf-8")
                request = urllib.request.Request(
                    f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
                    data=body,
                    headers={"Content-Type": "application/json", "Authorization": f"Bearer {model_key}"},
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=2) as response:
                    return response.status, response.read().decode("utf-8")

            try:
                add_messages = [
                    {"role": "system", "content": portal_soul},
                    {"role": "user", "content": f"Store this exact synthetic marker in persistent memory: IACQUIRE_MEMORY_ACCEPTANCE_ADD:{marker}"},
                ]
                status, first = post({"messages": add_messages, "tools": [tool]})
                self.assertEqual(status, 200)
                call = first["choices"][0]["message"]["tool_calls"][0]
                self.assertEqual(call["function"]["name"], "memory")
                self.assertEqual(json.loads(call["function"]["arguments"]), {"action": "add", "target": "memory", "content": marker})

                status, completed = post({"messages": add_messages + [
                    {"role": "assistant", "tool_calls": [call]},
                    {"role": "tool", "name": "memory", "tool_call_id": call["id"], "content": json.dumps({"success": True})},
                ]})
                self.assertEqual(status, 200)
                self.assertEqual(completed["choices"][0]["message"]["content"], challenge)
                self.assertEqual(state.hermes_memory_tool_calls, 1)
                self.assertEqual(state.hermes_memory_tool_results, 1)

                try:
                    post({"messages": add_messages + [
                        {"role": "assistant", "tool_calls": [call]},
                        {"role": "tool", "name": "memory", "tool_call_id": "unrelated-call", "content": json.dumps({"success": True})},
                    ]})
                except urllib.error.HTTPError as error:
                    self.assertEqual(error.code, 400)
                    self.assertEqual(json.loads(error.read())["error"]["message"], "hermes_memory_tool_result_unverified")
                else:
                    self.fail("a mismatched tool result must not prove a persistent-memory write")

                own_prompt = f"Return this exact marker only if present in persistent memory: IACQUIRE_MEMORY_ACCEPTANCE_RECALL:{marker}"
                status, own = post({"messages": [
                    {"role": "system", "content": portal_soul + f"\nPersistent memory: {marker}"},
                    {"role": "user", "content": own_prompt},
                ]})
                self.assertEqual(status, 200)
                self.assertEqual(own["choices"][0]["message"]["content"], marker)

                foreign_marker = "IACQUIRE_HERMES_MEMORY_abcdef0123456789abcdef0123456789"
                status, foreign = post({"messages": [
                    {"role": "system", "content": portal_soul + f"\nPersistent memory: {marker}"},
                    {"role": "user", "content": f"Return this exact marker only if present in persistent memory: IACQUIRE_MEMORY_ACCEPTANCE_RECALL:{foreign_marker}"},
                ]})
                self.assertEqual(status, 200)
                self.assertEqual(foreign["choices"][0]["message"]["content"], acceptance_harness.MEMORY_NOT_FOUND)

                stream_marker = "IACQUIRE_HERMES_MEMORY_11111111111111111111111111111111"
                status, stream = post_stream({
                    "stream": True,
                    "tools": [tool],
                    "messages": [
                        {"role": "system", "content": portal_soul},
                        {"role": "user", "content": f"Store this exact synthetic marker in persistent memory: IACQUIRE_MEMORY_ACCEPTANCE_ADD:{stream_marker}"},
                    ],
                })
                self.assertEqual(status, 200)
                self.assertIn('"name":"memory"', stream)
                self.assertIn('"finish_reason":"tool_calls"', stream)
            finally:
                server.shutdown()
                server.server_close()
                server_thread.join(timeout=2)

            diagnostic_text = (Path(directory) / "model-diagnostics.json").read_text(encoding="utf-8")
            for private_value in (model_key, marker, stream_marker, challenge):
                self.assertNotIn(private_value, diagnostic_text)

    def test_gateway_restart_memory_probe_uses_profile_isolation_and_updates_final_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profiles = root / "profiles"
            results = root / "results"
            results.mkdir()
            probes = []
            markers = {}
            for index, tenant in enumerate(TENANTS):
                profile = f"{tenant}-growth-partner"
                marker = f"IACQUIRE_HERMES_MEMORY_{index:032x}"
                markers[profile] = marker
                profile_dir = profiles / profile
                memory_dir = profile_dir / "memories"
                memory_dir.mkdir(parents=True)
                (profile_dir / ".env").write_text(f"API_SERVER_KEY={'a' * 63}{index}\n", encoding="ascii")
                (memory_dir / "MEMORY.md").write_text(f"- {marker}\n", encoding="utf-8")
                probes.append({"tenant": tenant, "profile": profile, "orgId": f"00000000-0000-4000-8000-00000000000{index + 1}", "marker": marker})
            (results / "hermes-memory-probes.json").write_text(
                json.dumps({"schemaVersion": 1, "probes": probes}), encoding="utf-8"
            )
            (results / "status.json").write_text(
                json.dumps({"result": "SANDBOX_PASS", "hermesMemoryVerified": False}), encoding="utf-8"
            )

            def fake_chat(_base, profile, _key, _session_key, prompt):
                match = acceptance_harness.MEMORY_RECALL_REQUEST_RE.search(prompt)
                self.assertIsNotNone(match)
                requested = match.group(1)
                return requested if markers[profile] == requested else acceptance_harness.MEMORY_NOT_FOUND

            with patch.dict(os.environ, {
                "ACCEPTANCE_PROFILE_ROOT": str(profiles),
                "ACCEPTANCE_RESULTS_DIR": str(results),
            }), patch("acceptance_harness._hermes_memory_chat", side_effect=fake_chat):
                result = verify_hermes_memory_after_restart()

            self.assertTrue(result["hermesMemoryVerified"])
            self.assertEqual(result["hermesMemoryRestartVerifiedProfiles"], EXPECTED_PROFILES)
            self.assertEqual(result["hermesMemoryRestartForeignDenials"], EXPECTED_PROFILES)
            self.assertEqual(json.loads((results / "status.json").read_text(encoding="utf-8")), result)

    def test_readonly_mounted_secret_mode_does_not_weaken_profile_file_mode(self):
        if os.name == "nt":
            self.skipTest("POSIX file permission modes are required for this check")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic-secret"
            path.write_text("synthetic-value", encoding="utf-8")
            path.chmod(0o400)

            self.assertEqual(read_private_text(path, expected_mode=0o400), "synthetic-value")
            with self.assertRaises(VerificationError) as profile_mode_error:
                read_private_text(path)
            self.assertEqual(str(profile_mode_error.exception), "private_file_mode_mismatch")

            path.chmod(0o644)
            with self.assertRaises(VerificationError) as exposed_mode_error:
                read_private_text(path, expected_mode=0o400)
            self.assertEqual(str(exposed_mode_error.exception), "private_file_mode_mismatch")

    def test_root_owned_group_readonly_gateway_key_uses_an_explicit_owner_check(self):
        if os.name == "nt":
            self.skipTest("POSIX ownership and file permission modes are required for this check")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "hermes-api-key"
            path.write_text("synthetic-hermes-api-key", encoding="utf-8")
            path.chmod(0o440)

            self.assertEqual(
                read_private_text(
                    path,
                    expected_mode=0o440,
                    expected_uid=os.getuid(),
                    expected_gid=os.getgid(),
                ),
                "synthetic-hermes-api-key",
            )
            with self.assertRaises(VerificationError) as owner_error:
                read_private_text(path, expected_mode=0o440, expected_uid=os.getuid() + 1, expected_gid=os.getgid())
            self.assertEqual(str(owner_error.exception), "private_file_owner_mismatch")

    def test_model_diagnostics_capture_portal_deltas_without_request_contents(self):
        model_key = "synthetic-model-key-not-for-diagnostics"
        challenge = "0123456789abcdef0123456789abcdef"
        with tempfile.TemporaryDirectory() as directory:
            state = AcceptanceState("00000000-0000-4000-8000-000000000001", Path(directory))
            state.accept_model_call(True, chat_completion=True)
            state.record_model_response(200)
            state.begin_portal_phase()

            server = ThreadingHTTPServer(("127.0.0.1", 0), _model_handler(state, model_key))
            server_thread = threading.Thread(target=server.serve_forever, daemon=True)
            server_thread.start()

            def post(payload, authorization):
                body = json.dumps(payload).encode("utf-8")
                request = urllib.request.Request(
                    f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
                    data=body,
                    headers={"Content-Type": "application/json", "Authorization": authorization},
                    method="POST",
                )
                try:
                    with urllib.request.urlopen(request, timeout=2) as response:
                        return response.status, json.loads(response.read())
                except urllib.error.HTTPError as error:
                    try:
                        payload = json.loads(error.read())
                    except json.JSONDecodeError:
                        payload = None
                    return error.code, payload

            def get(path, authorization):
                request = urllib.request.Request(
                    f"http://127.0.0.1:{server.server_port}{path}",
                    headers={"Authorization": authorization},
                    method="GET",
                )
                try:
                    with urllib.request.urlopen(request, timeout=2) as response:
                        response.read()
                        return response.status
                except urllib.error.HTTPError as error:
                    error.read()
                    return error.code

            try:
                self.assertEqual(post({"messages": [{"role": "user", "content": "secret-canary-sentinel"}]}, "Bearer wrong-secret")[0], 401)
                self.assertEqual(post({"messages": [{"role": "user", "content": "secret-canary-sentinel"}]}, f"Bearer {model_key}")[0], 400)
                portal_soul = (
                    "## Private runtime initialization check\n"
                    "A private setup check may ask for the initialization marker below. "
                    "Return it only for that exact setup check and never include it in ordinary user replies.\n"
                    f"{challenge}\n"
                )
                status, response = post(
                    {
                        "messages": [
                            {"role": "system", "content": portal_soul},
                            {"role": "user", "content": "Return only the iAcquire profile initialization marker in your permanent identity instructions."},
                        ]
                    },
                    f"Bearer {model_key}",
                )
                self.assertEqual(status, 200)
                self.assertEqual(response["choices"][0]["message"]["content"], challenge)
                self.assertEqual(
                    post(
                        {"messages": [{"role": "user", "content": f"For setup, return this marker exactly: {challenge}"}]},
                        f"Bearer {model_key}",
                    )[0],
                    400,
                )
                self.assertEqual(get("/v1/unsupported", f"Bearer {model_key}"), 404)
            finally:
                server.shutdown()
                server.server_close()
                server_thread.join(timeout=2)

            diagnostic_path = Path(directory) / "model-diagnostics.json"
            diagnostic_text = diagnostic_path.read_text(encoding="utf-8")
            diagnostic = json.loads(diagnostic_text)
            self.assertEqual(diagnostic["schemaVersion"], 1)
            self.assertEqual(
                diagnostic["portalPhaseBaseline"],
                {
                    "requests": 1,
                    "authorizedRequests": 1,
                    "chatRequests": 1,
                    "authorizedChatRequests": 1,
                    "authenticationFailures": 0,
                    "successResponses": 1,
                    "errorResponses": 0,
                    "invalidRequests": 0,
                    "missingChallengeMarker": 0,
                    "endpointNotFound": 0,
                },
            )
            self.assertEqual(
                diagnostic["counters"],
                {
                    "requests": 6,
                    "authorizedRequests": 5,
                    "chatRequests": 5,
                    "authorizedChatRequests": 4,
                    "authenticationFailures": 1,
                    "successResponses": 2,
                    "errorResponses": 4,
                    "invalidRequests": 2,
                    "missingChallengeMarker": 2,
                    "endpointNotFound": 1,
                },
            )
            for private_value in (model_key, "wrong-secret", "secret-canary-sentinel", challenge, "northstar-synthetic", "redwood-synthetic"):
                self.assertNotIn(private_value, diagnostic_text)

    def test_model_challenge_uses_only_the_system_prompt(self):
        challenge = "0123456789abcdef0123456789abcdef"
        soul = f"For the private setup check only, return this marker exactly: {challenge}"
        self.assertEqual(
            _model_request_challenge({"messages": [{"role": "system", "content": soul}]}),
            challenge,
        )
        self.assertIsNone(
            _model_request_challenge({"messages": [{"role": "user", "content": soul}]})
        )

    def test_portal_soul_challenge_survives_runtime_prompt_suffix(self):
        challenge = "0123456789abcdef0123456789abcdef"
        soul = (
            "## Private runtime initialization check\n"
            "A private setup check may ask for the initialization marker below. "
            "Return it only for that exact setup check and never include it in ordinary user replies.\n"
            f"{challenge}\n"
        )
        request = {
            "messages": [
                {
                    "role": "system",
                    "content": soul + "\n## Runtime environment\nHermes runtime guidance follows.",
                }
            ]
        }
        self.assertEqual(_model_request_challenge(request), challenge)

    def test_portal_poll_waits_for_a_bounded_retry_but_rejects_exhausted_or_unclassified_failures(self):
        scheduled_retry = {
            "failedJobs": 1,
            "jobDiagnostics": [
                {"jobStatus": "failed", "attempt": 1, "maxAttempts": 3, "retryState": "retry_scheduled"}
            ],
        }
        self.assertEqual(_portal_status_state(scheduled_retry, "provision"), "waiting")
        self.assertEqual(
            _portal_status_state(
                {
                    "failedJobs": 1,
                    "jobDiagnostics": [
                        {"jobStatus": "failed", "attempt": 3, "maxAttempts": 3, "retryState": "retry_exhausted"}
                    ],
                },
                "provision",
            ),
            "failed",
        )
        self.assertEqual(_portal_status_state({"failedJobs": 1, "jobDiagnostics": []}, "sync"), "failed")
        self.assertEqual(
            _portal_status_state(
                {
                    "mappedProfiles": EXPECTED_PROFILES,
                    "provisionRequested": 0,
                    "provisionInProgress": 0,
                    "provisionAwaitingHealthCheck": EXPECTED_PROFILES,
                    "failedJobs": 0,
                },
                "provision",
            ),
            "ready",
        )

    def test_failure_diagnostics_expose_only_synthetic_model_call_counts(self):
        state = AcceptanceState("00000000-0000-4000-8000-000000000001", Path("/tmp"))
        state.model_calls = 5
        state.model_chat_calls = 4
        state.model_bad_auth = 1
        self.assertEqual(
            _synthetic_model_counters(state),
            {"modelCalls": 5, "modelChatCalls": 4, "modelAuthenticationFailures": 1},
        )

    def test_model_fixture_stays_available_until_explicit_compose_shutdown(self):
        state = AcceptanceState("00000000-0000-4000-8000-000000000001", Path("/tmp"))
        server = ThreadingHTTPServer(("127.0.0.1", 0), _model_handler(state, "synthetic-model-key"))
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        shutdown_requested = threading.Event()
        lifecycle_thread = threading.Thread(
            target=_hold_fixture_until_shutdown,
            args=(shutdown_requested,),
            daemon=True,
        )
        lifecycle_thread.start()
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{server.server_port}/healthz", timeout=2) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read()), {"ok": True})
            self.assertTrue(lifecycle_thread.is_alive())
        finally:
            shutdown_requested.set()
            lifecycle_thread.join(timeout=2)
            server.shutdown()
            server.server_close()
            server_thread.join(timeout=2)
        self.assertFalse(lifecycle_thread.is_alive())

    def test_audit_diagnostic_exposes_only_the_observed_record_count(self):
        state = AcceptanceState("00000000-0000-4000-8000-000000000001", Path("/tmp"))
        state.audit_events_observed = 16
        state.audit_event_summary_observed = {
            "auditSucceededObserved": 14,
            "auditFailedObserved": 1,
            "auditRejectedObserved": 1,
            "auditProvisionObserved": 14,
            "auditSyncObserved": 2,
            "auditRecoveryFailureObserved": 1,
        }
        self.assertEqual(
            _audit_event_diagnostic(state),
            {"auditEventsObserved": 16, **state.audit_event_summary_observed},
        )

    def test_fixture_has_one_growth_partner_identity_per_tenant(self):
        state = AcceptanceState("00000000-0000-4000-8000-000000000001", Path("/tmp"))
        self.assertEqual(len(state.base_jobs), EXPECTED_PROFILES)
        self.assertEqual(len({job["profile"] for job in state.base_jobs.values()}), EXPECTED_PROFILES)
        for tenant in TENANTS:
            jobs = [job for job in state.base_jobs.values() if tenant in job["soul"]]
            self.assertEqual({job["role"] for job in jobs}, {"growth_partner"})
            self.assertEqual(len(jobs), PROFILES_PER_TENANT)
            self.assertEqual(len({job["orgId"] for job in jobs}), 1)
            self.assertTrue(all(job["profile"].startswith("c-") for job in jobs))
        self.assertNotIn("iAcquire", " ".join(job["soul"] for job in state.base_jobs.values()))

    def test_worker_failure_retry_duplicate_and_sync_are_distinct_idempotent_steps(self):
        gateway = "00000000-0000-4000-8000-000000000001"
        state = AcceptanceState(gateway, Path("/tmp"))
        first = state.claim(gateway)
        first_challenge = first["soulChallenge"]
        other_challenge = next(
            job["soulChallenge"] for job in state.base_jobs.values()
            if job["jobId"] != first["jobId"]
        )
        self.assertTrue(state.should_inject_canary_mismatch(first_challenge))
        self.assertTrue(state.should_inject_canary_mismatch(first_challenge))
        self.assertFalse(state.should_inject_canary_mismatch(other_challenge))
        state.complete({
            "ok": False,
            "jobId": first["jobId"],
            "leaseToken": first["leaseToken"],
            "gatewayId": gateway,
            "code": "effective_soul_unverified",
        })
        self.assertFalse(state.should_inject_canary_mismatch(first_challenge))
        retry = state.claim(gateway)
        self.assertEqual(retry["jobId"], first["jobId"])
        while True:
            job = retry if state.active is None else state.active
            if job is None:
                job = state.claim(gateway)
            self._complete_success(state, job, gateway)
            if state.sync_completed:
                break
            retry = None
            next_job = state.claim(gateway)
            if next_job is None:
                self.fail("fixture queue ended before duplicate and sync jobs")
            retry = next_job

        self.assertTrue(state.failed_once)
        self.assertTrue(state.duplicate_completed)
        self.assertTrue(state.sync_completed)
        self.assertEqual(len(state.base_success_profiles), EXPECTED_PROFILES)
        self.assertEqual(len(state.profile_keys), EXPECTED_PROFILES)
        self.assertEqual(len(set(state.profile_keys.values())), EXPECTED_PROFILES)
        self.assertEqual(state.latest_manifest[first["profile"]]["configVersion"], 2)

    def test_unexpected_worker_failure_keeps_only_a_safe_code_for_diagnostics(self):
        gateway = "00000000-0000-4000-8000-000000000001"
        state = AcceptanceState(gateway, Path("/tmp"))
        job = state.claim(gateway)
        with self.assertRaisesRegex(ValueError, "unexpected_provisioning_failure"):
            state.complete({
                "ok": False,
                "jobId": job["jobId"],
                "leaseToken": job["leaseToken"],
                "gatewayId": gateway,
                "code": "profile_create_failed",
            })
        self.assertEqual(state.worker_failure_code, "profile_create_failed")

        other = AcceptanceState(gateway, Path("/tmp"))
        job = other.claim(gateway)
        with self.assertRaisesRegex(ValueError, "unexpected_provisioning_failure"):
            other.complete({
                "ok": False,
                "jobId": job["jobId"],
                "leaseToken": job["leaseToken"],
                "gatewayId": gateway,
                "code": "not-a-safe-code value",
            })
        self.assertEqual(other.worker_failure_code, "unknown")

    def _complete_success(self, state, job, gateway):
        profile = job["profile"]
        key = hashlib.sha256(profile.encode("ascii")).hexdigest()
        result = {
            "ok": True,
            "jobId": job["jobId"],
            "leaseToken": job["leaseToken"],
            "gatewayId": gateway,
            "kind": job["kind"],
            "orgId": job["orgId"],
            "agentId": job["agentId"],
            "profile": profile,
            "configVersionId": job["configVersionId"],
            "soulSha256": job["soulSha256"],
            "soulChallengeSha256": hashlib.sha256(job["soulChallenge"].encode("ascii")).hexdigest(),
            "policyConfigSha256": job["policyConfigSha256"],
            "authenticated": True,
            "identityVerified": True,
            "effectiveSoulVerified": True,
            "toolInventoryComplete": True,
            "toolInventoryDigest": "f" * 64,
            "hermesVersion": "hermes v0.22.5 acceptance",
        }
        if job["kind"] == "provision":
            result["apiKey"] = key
        state.complete(result)


if __name__ == "__main__":
    unittest.main()
