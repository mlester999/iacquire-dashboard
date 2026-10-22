import hashlib
import unittest
from pathlib import Path

from acceptance_harness import AcceptanceState, ROLE_TITLES, TENANTS, _audit_event_diagnostic, _synthetic_model_counters


class AcceptanceFixtureTests(unittest.TestCase):
    def test_failure_diagnostics_expose_only_synthetic_model_call_counts(self):
        state = AcceptanceState("00000000-0000-4000-8000-000000000001", Path("/tmp"))
        state.model_calls = 5
        state.model_chat_calls = 4
        state.model_bad_auth = 1
        self.assertEqual(
            _synthetic_model_counters(state),
            {"modelCalls": 5, "modelChatCalls": 4, "modelAuthenticationFailures": 1},
        )

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
