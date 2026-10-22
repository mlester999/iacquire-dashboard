import hashlib
import unittest
from pathlib import Path

from acceptance_harness import AcceptanceState, ROLE_TITLES, TENANTS


class AcceptanceFixtureTests(unittest.TestCase):
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
        state.complete({
            "ok": False,
            "jobId": first["jobId"],
            "leaseToken": first["leaseToken"],
            "gatewayId": gateway,
            "code": "effective_soul_unverified",
        })
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
