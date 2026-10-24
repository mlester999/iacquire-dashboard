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

from acceptance_harness import (
    AcceptanceState,
    ROLE_TITLES,
    TENANTS,
    _audit_event_diagnostic,
    _hold_fixture_until_shutdown,
    _model_handler,
    _model_request_challenge,
    _portal_status_state,
    _synthetic_model_counters,
)
from verify_portal_acceptance import VerificationError, read_private_text


class AcceptanceFixtureTests(unittest.TestCase):
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
                    "mappedProfiles": 12,
                    "provisionRequested": 0,
                    "provisionInProgress": 0,
                    "provisionAwaitingHealthCheck": 12,
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

    def test_fixture_is_two_isolated_tenants_with_all_six_roles(self):
        state = AcceptanceState("00000000-0000-4000-8000-000000000001", Path("/tmp"))
        self.assertEqual(len(state.base_jobs), 12)
        self.assertEqual(len({job["profile"] for job in state.base_jobs.values()}), 12)
        for tenant in TENANTS:
            jobs = [job for job in state.base_jobs.values() if tenant in job["soul"]]
            self.assertEqual({job["role"] for job in jobs}, set(ROLE_TITLES))
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
        self.assertEqual(len(state.base_success_profiles), 12)
        self.assertEqual(len(state.profile_keys), 12)
        self.assertEqual(len(set(state.profile_keys.values())), 12)
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
            "hermesVersion": "hermes v0.22.3 acceptance",
        }
        if job["kind"] == "provision":
            result["apiKey"] = key
        state.complete(result)


if __name__ == "__main__":
    unittest.main()
